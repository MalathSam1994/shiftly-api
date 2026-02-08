// routes/userRoles.js
// User <-> Role mapping (for admin "Roles" screen)
const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /user-roles/:userId
router.get('/:userId', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const sql = `
      SELECT ur.id, ur.user_id, ur.role_id, ur.is_primary,
             r.role_code, r.role_name
      FROM shiftly_schema.user_roles ur
      JOIN shiftly_schema.roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY ur.is_primary DESC, r.role_code
    `;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (e) {
    console.error('USER ROLES GET error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /user-roles/:userId -> replace full role set
// body: { roleIds: number[], primaryRoleId?: number }
router.post('/:userId', async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.userId);
    const roleIds = Array.isArray(req.body?.roleIds)
      ? req.body.roleIds.map(Number).filter(n => Number.isFinite(n))
      : [];
    const primaryRoleId = Number.isFinite(Number(req.body?.primaryRoleId))
      ? Number(req.body.primaryRoleId)
      : null;

    await client.query('BEGIN');
    await client.query(`DELETE FROM shiftly_schema.user_roles WHERE user_id = $1`, [userId]);

    for (const rid of roleIds) {
      const isPrimary = primaryRoleId != null && rid === primaryRoleId;
      await client.query(
        `INSERT INTO shiftly_schema.user_roles(user_id, role_id, is_primary)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, rid, isPrimary]
      );
    }

    if (primaryRoleId != null) {
      await client.query(`UPDATE shiftly_schema.users SET role_id = $1 WHERE id = $2`, [primaryRoleId, userId]);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('USER ROLES REPLACE error:', e);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

module.exports = router;
