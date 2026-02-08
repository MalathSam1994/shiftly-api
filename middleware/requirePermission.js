// middleware/requirePermission.js
const pool = require('../db');

function requirePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const userId = Number(req.user?.sub ?? req.user?.id);
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { rows } = await pool.query(
        `SELECT shiftly_api.fn_user_has_permission($1, $2) AS ok`,
        [userId, permissionKey]
      );

      if (!rows?.[0]?.ok) {
        return res.status(403).json({ error: 'Forbidden', permission: permissionKey });
      }

      next();
    } catch (e) {
      console.error('requirePermission error:', e);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

module.exports = requirePermission;