const jwt = require('jsonwebtoken');
const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_TOKEN_MISSING',
    });
  }

  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    // ✅ Enforce "single active session" per user:
   // token must carry sv (session version) that matches DB.
   const userId = Number(payload?.sub);
   const tokenSv = Number(payload?.sv);
   if (!userId || !Number.isFinite(tokenSv)) {
     return sendApiError(req, res, {
       status: 401,
       error: 'Your session has expired. Please sign in again.',
       code: 'AUTH_TOKEN_INVALID',
     });
   }
   const db = await pool.query(
   `SELECT COALESCE(session_version, 0) AS session_version,
           is_active
    FROM shiftly_schema.users
    WHERE id = $1`,
     [userId],
   );
   if (db.rows.length === 0) {
     return sendApiError(req, res, {
       status: 401,
       error: 'Your session has expired. Please sign in again.',
       code: 'AUTH_TOKEN_INVALID',
     });
   }
   const currentSv = Number(db.rows[0].session_version ?? 0);
   if (db.rows[0].is_active !== true) {
     return sendApiError(req, res, {
       status: 401,
       error: 'Your session has expired. Please sign in again.',
       code: 'AUTH_TOKEN_INVALID',
     });
   }
   if (tokenSv !== currentSv) {
     // Token belongs to an older session (user logged in elsewhere).
     return sendApiError(req, res, {
       status: 401,
       error: 'Your session was replaced by another sign-in.',
       code: 'SESSION_REPLACED',
     });
   }
req.user = { ...payload, id: userId };// { sub, role_id, user_type, sv, ... }
   return next();
  } catch (err) {
    if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
      return sendApiError(req, res, {
        status: 401,
        error: 'Your session has expired. Please sign in again.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }
    return sendPostgresError(req, res, err, {
      label: 'Authentication check failed',
    });
  }
}

module.exports = requireAuth;
