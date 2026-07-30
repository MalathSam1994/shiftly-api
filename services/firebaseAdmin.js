const {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const pool = require('../db');
const fs = require('fs');
let _firebaseApp = null;

function initFirebase() {
 if (_firebaseApp) {
   return _firebaseApp;
 }

 // Reuse an already initialized default app when this module is loaded
 // more than once during tests, reloads, or application startup.
 const existingApps = getApps();
 if (existingApps.length > 0) {
   _firebaseApp = existingApps[0];
   return _firebaseApp;
 }

  // Option A: Use GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json
  // Option B: Use FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let serviceAccount;

    try {
      serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
      );
    } catch (error) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON contains invalid JSON.',
        { cause: error },
      );
    }

    credential = cert(serviceAccount);
  } else {
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (credentialsPath && !fs.existsSync(credentialsPath)) {
      throw new Error(
        `GOOGLE_APPLICATION_CREDENTIALS file not found: ${credentialsPath}`,
      );
    }

    credential = applicationDefault();
  }

  _firebaseApp = initializeApp({ credential });

  console.log('[firebaseAdmin] initialized', {
    projectId: _firebaseApp.options.projectId || null,
    credentialMode: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? 'FIREBASE_SERVICE_ACCOUNT_JSON'
      : 'APPLICATION_DEFAULT',
  });

  return _firebaseApp;
}

async function getTokensForUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT token FROM shiftly_schema.user_fcm_tokens WHERE user_id = ANY($1::int[])`,
    [userIds]
  );
  const tokens = rows.map(r => r.token).filter(Boolean);
  console.log('[firebaseAdmin] tokens fetched', {
    userIds,
    tokenCount: tokens.length,
  });
  return tokens;
}

async function removeBadTokens(tokens) {
  if (!tokens || tokens.length === 0) return;
  await pool.query(
    `DELETE FROM shiftly_schema.user_fcm_tokens WHERE token = ANY($1::text[])`,
    [tokens]
  );
}

async function sendToUsers({ userIds, title, body, data }) {
  const firebaseApp = initFirebase();
  const messaging = getMessaging(firebaseApp);

  const tokens = await getTokensForUsers(userIds);
  if (tokens.length === 0) {
    console.log('[firebaseAdmin] no tokens for users', { userIds });
    return { ok: true, sent: 0 };
  }

  // FCM data values must be strings.
  const dataStrings = {};
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (v == null) continue;
      dataStrings[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  // Multicast max 500 tokens per request
  let sent = 0;
  const badTokens = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    console.log('[firebaseAdmin] sendEachForMulticast start', {
      chunkSize: chunk.length,
      title,
      body,
      data: dataStrings,
    });

    const resp = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: {
        title: String(title || 'ShiftMix'),
        body: String(body || ''),
      },
      data: dataStrings,
      android: {
        priority: 'high',
      },
       apns: {
       headers: {
         'apns-priority': '10',
         'apns-push-type': 'alert',
       },
       payload: {
         aps: {
           sound: 'default',
           badge: 1,
         },
       },
     },
    });

    sent += resp.successCount;
    console.log('[firebaseAdmin] multicast result', {
      successCount: resp.successCount,
      failureCount: resp.failureCount,
    });

    resp.responses.forEach((r, idx) => {
      console.log('[firebaseAdmin] token result', {
        success: r.success,
        code: r.error?.code || null,
        message: r.error?.message || null,
      });
  
      if (!r.success) {
        const code = r.error?.code || '';
        console.log('[firebaseAdmin] token failure', {
          code,
        });

        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token')
        ) {
          badTokens.push(chunk[idx]);
        }
      }
    });
  }

  await removeBadTokens(badTokens);
  console.log('[firebaseAdmin] sendToUsers end', {
    sent,
    removedBadTokens: badTokens.length,
  });

  return { ok: true, sent };
}

module.exports = { sendToUsers };
