// routes/rolePermissions.js
// Role <-> Permission mapping (DB is authority; UI manages it here)
const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /role-permissions/:roleId -> list permission_key for role
router.get('/:roleId', async (req, res) => {
  try {
    const roleId = Number(req.params.roleId);
    const sql = `
      SELECT rp.id, p.id AS permission_id, p.permission_key, p.permission_desc
      FROM shiftly_schema.role_permissions rp
      JOIN shiftly_schema.permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.permission_key
    `;
    const result = await pool.query(sql, [roleId]);
    res.json(result.rows);
  } catch (e) {
    console.error('ROLE PERMISSIONS GET error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /role-permissions/:roleId -> replace full permission set
// body: { permissionIds: number[] }
router.post('/:roleId', async (req, res) => {
  const client = await pool.connect();
  try {
    const roleId = Number(req.params.roleId);
    const permissionIds = Array.isArray(req.body?.permissionIds)
      ? req.body.permissionIds.map(Number).filter(n => Number.isFinite(n))
      : [];

    await client.query('BEGIN');
    await client.query(`DELETE FROM shiftly_schema.role_permissions WHERE role_id = $1`, [roleId]);

    for (const pid of permissionIds) {
      await client.query(
        `INSERT INTO shiftly_schema.role_permissions(role_id, permission_id) VALUES ($1, $2)
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [roleId, pid]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('ROLE PERMISSIONS REPLACE error:', e);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

module.exports = router;
