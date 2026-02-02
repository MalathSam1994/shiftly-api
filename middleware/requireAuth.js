const jwt = require('jsonwebtoken');
const pool = require('../db');

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Missing Bearer token' });

  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    // ✅ Enforce "single active session" per user:
   // token must carry sv (session version) that matches DB.
   const userId = Number(payload?.sub);
   const tokenSv = Number(payload?.sv);
   if (!userId || !Number.isFinite(tokenSv)) {
     return res.status(401).json({ error: 'Invalid or expired token' });
   }
   const db = await pool.query(
     `SELECT session_version FROM shiftly_schema.users WHERE id = $1`,
     [userId],
   );
   if (db.rows.length === 0) {
     return res.status(401).json({ error: 'Invalid or expired token' });
   }
   const currentSv = Number(db.rows[0].session_version ?? 0);
   if (tokenSv !== currentSv) {
     // Token belongs to an older session (user logged in elsewhere).
     return res.status(401).json({ error: 'Session replaced by another login' });
   }
   req.user = payload; // { sub, role_id, user_type, sv, ... }
   return next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = requireAuth;