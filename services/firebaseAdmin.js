const admin = require('firebase-admin');
const pool = require('../db');
const fs = require('fs');
let _inited = false;

function initFirebase() {
  if (_inited) return;

  // Option A: Use GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json
  // Option B: Use FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(json) });
  } else {
	  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
   if (p && !fs.existsSync(p)) {
     throw new Error(`GOOGLE_APPLICATION_CREDENTIALS file not found: ${p}`);
   }
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }

  _inited = true;
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
    tokenPrefixes: tokens.map(t => t.substring(0, t.length > 18 ? 18 : t.length)),
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
  initFirebase();

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
    const resp = await admin.messaging().sendEachForMulticast({
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
   tokenPrefix: chunk[idx].substring(0, chunk[idx].length > 18 ? 18 : chunk[idx].length),
 });      
      if (!r.success) {
        const code = r.error?.code || '';
       console.log('[firebaseAdmin] token failure', {
         code,
         tokenPrefix: chunk[idx].substring(0, chunk[idx].length > 18 ? 18 : chunk[idx].length),
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
console.log('[firebaseAdmin] sendToUsers end', { sent, removedBadTokens: badTokens.length });
  return { ok: true, sent };
}

module.exports = { sendToUsers };
