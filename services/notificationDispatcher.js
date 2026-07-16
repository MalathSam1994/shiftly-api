const { Client } = require('pg');
const pool = require('../db');
const { sendToUsers } = require('./firebaseAdmin');

const CHANNEL = 'shiftly_notification_inserted';

let _started = false;
let _client = null;

function _safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

async function _dispatchByNotificationId(notificationId) {
  console.log('[dispatcher] dispatch start', { notificationId });
  // Keep transaction open while sending to avoid duplicates across concurrent notifies.
  await _client.query('BEGIN');
  try {
    const { rows } = await _client.query(
      `
      SELECT
        id,
        recipient_user_id,
        notification_type,
        title,
        body,
        payload,
        push_sent_at,
        push_attempts,
        u.is_active AS recipient_is_active
      FROM shiftly_schema.notifications
      JOIN shiftly_schema.users u ON u.id = recipient_user_id
      WHERE id = $1
      FOR UPDATE
      `,
      [notificationId],
    );

    const n = rows[0];
    if (!n) {
      console.log('[dispatcher] notification not found', { notificationId });
      await _client.query('COMMIT');
      return;
    }

    if (n.recipient_is_active !== true) {
      console.log('[dispatcher] recipient inactive, skipping push', {
        notificationId: n.id,
        recipientUserId: n.recipient_user_id,
      });
      await _client.query(
        `
        UPDATE shiftly_schema.notifications
        SET push_attempts = push_attempts + 1,
            last_push_error = 'RECIPIENT_INACTIVE'
        WHERE id = $1
        `,
        [n.id],
      );
      await _client.query('COMMIT');
      return;
    }

    // already sent
    if (n.push_sent_at) {
      console.log('[dispatcher] already sent', { notificationId: n.id });
      await _client.query('COMMIT');
      return;
    }

    // stop retrying after a few attempts
    if ((n.push_attempts ?? 0) >= 5) {
     console.log('[dispatcher] max attempts reached', {
       notificationId: n.id,
       pushAttempts: n.push_attempts,
     });
      await _client.query('COMMIT');
      return;
    }

    // Build FCM data payload (MUST be strings; firebaseAdmin.js already stringifies)
    const data = {};
    if (n.payload && typeof n.payload === 'object') {
      Object.assign(data, n.payload);
    }
    if (!data.route) data.route = '/notifications';
    data.type = n.notification_type || 'UNKNOWN';
    data.notificationId = String(n.id);
    data.recipientUserId = String(n.recipient_user_id);
   console.log('[dispatcher] payload built', {
     notificationId: n.id,
     recipientUserId: n.recipient_user_id,
     title: n.title,
     body: n.body,
     data,
   });

    let sent = 0;
    let errText = null;

    try {
     console.log('[dispatcher] sending push', {
       notificationId: n.id,
       recipientUserId: n.recipient_user_id,
     });
      const resp = await sendToUsers({
        userIds: [n.recipient_user_id],
        title: n.title || 'Shiftly',
        body: n.body || '',
        data,
      });
      sent = resp?.sent ?? 0;
     console.log('[dispatcher] send result', {
       notificationId: n.id,
       sent,
     });
    } catch (err) {
      errText = err?.message || String(err);
      console.error('FCM dispatch error:', errText);
    }

    if (sent > 0) {
       console.log('[dispatcher] marking sent', { notificationId: n.id });
      await _client.query(
        `
        UPDATE shiftly_schema.notifications
        SET push_sent_at = CURRENT_TIMESTAMP,
            push_attempts = push_attempts + 1,
            last_push_error = NULL
        WHERE id = $1
        `,
        [n.id],
      );
    } else {
     console.log('[dispatcher] marking failed', {
       notificationId: n.id,
       error: errText || 'NO_TOKENS_OR_NOT_DELIVERED',
     });
      await _client.query(
        `
        UPDATE shiftly_schema.notifications
        SET push_attempts = push_attempts + 1,
            last_push_error = $2
        WHERE id = $1
        `,
        [n.id, errText || 'NO_TOKENS_OR_NOT_DELIVERED'],
      );
    }

    await _client.query('COMMIT');
  } catch (e) {
    await _client.query('ROLLBACK');
    console.error('Notification dispatcher failed:', e);
  }
}

async function _drainPending(limit = 100) {
  console.log('[dispatcher] drain start', { limit });
  // Drain older pending rows (covers: API restart, token registered later, missed NOTIFY, etc.)
  const { rows } = await pool.query(
    `
    SELECT id
    FROM shiftly_schema.notifications
    WHERE push_sent_at IS NULL
      AND push_attempts < 5
    ORDER BY id ASC
    LIMIT $1
    `,
    [limit],
  );

  console.log('[dispatcher] drain found', {
    count: rows.length,
    ids: rows.map(r => Number(r.id)),
  });


  for (const r of rows) {
    await _dispatchByNotificationId(Number(r.id));
  }
}

async function startNotificationDispatcher() {
  if (_started) return;
  _started = true;

  _client = new Client(); // uses PG* env vars (same as your pool)
  await _client.connect();

  await _client.query(`LISTEN ${CHANNEL}`);
  console.log(`[dispatcher] LISTEN ${CHANNEL}`);

  // Initial drain on boot (in case app was down)
  _drainPending().catch((e) => console.error('[dispatcher] drain error:', e));

  // Periodic drain (keeps things robust)
  setInterval(() => {
    _drainPending().catch((e) => console.error('[dispatcher] drain error:', e));
  }, 60 * 1000);

  _client.on('notification', (msg) => {
    console.log('[dispatcher] postgres NOTIFY received', {
      channel: msg?.channel,
      payload: msg?.payload,
    });
    if (!msg || msg.channel !== CHANNEL) return;
    const p = _safeJsonParse(msg.payload || '');
    const id = Number(p?.notificationId);
    if (!id) return;

    // fire-and-forget (serialized by awaiting inside _dispatch)
    _dispatchByNotificationId(id).catch((e) =>
      console.error('[dispatcher] dispatch error:', e),
    );
  });

  _client.on('error', (err) => {
    console.error('[dispatcher] PG client error:', err);
  });
}

module.exports = { startNotificationDispatcher };
