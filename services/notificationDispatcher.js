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
        push_attempts
      FROM shiftly_schema.notifications
      WHERE id = $1
      FOR UPDATE
      `,
      [notificationId],
    );

    const n = rows[0];
    if (!n) {
      await _client.query('COMMIT');
      return;
    }

    // already sent
    if (n.push_sent_at) {
      await _client.query('COMMIT');
      return;
    }

    // stop retrying after a few attempts
    if ((n.push_attempts ?? 0) >= 5) {
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

    let sent = 0;
    let errText = null;

    try {
      const resp = await sendToUsers({
        userIds: [n.recipient_user_id],
        title: n.title || 'Shiftly',
        body: n.body || '',
        data,
      });
      sent = resp?.sent ?? 0;
    } catch (err) {
      errText = err?.message || String(err);
      console.error('FCM dispatch error:', errText);
    }

    if (sent > 0) {
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
