// routes/rolePermissions.js
// Role <-> Permission mapping (DB is authority; UI manages it here)
const express = require('express');
const pool = require('../db');
const {
  activeStatusSql,
  parseActiveStatusQuery,
  sendActiveStatusError,
} = require('../utils/activeStatus');

const router = express.Router();

// GET /role-permissions/:roleId -> list permission_key for role
router.get('/:roleId', async (req, res) => {
  try {
    const roleId = Number(req.params.roleId);
    const active = activeStatusSql(parseActiveStatusQuery(req.query), 'rp.is_active', 2);
    const activeClause = active.clause ? `AND ${active.clause}` : '';
    const sql = `
      SELECT rp.id, p.id AS permission_id, p.permission_key, p.permission_desc, rp.is_active
      FROM shiftly_schema.role_permissions rp
      JOIN shiftly_schema.permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ${activeClause}
      ORDER BY p.permission_key
    `;
    const result = await pool.query(sql, [roleId, ...active.params]);
    res.json(result.rows);
  } catch (e) {
    if (sendActiveStatusError(res, e)) return;
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
    const roleCheck = await client.query(
      `SELECT id FROM shiftly_schema.roles WHERE id = $1 AND is_active = true`,
      [roleId],
    );
    if (roleCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot assign permissions to an inactive or missing role.' });
    }

    if (permissionIds.length > 0) {
      const permCheck = await client.query(
        `SELECT id FROM shiftly_schema.permissions WHERE id = ANY($1::int[]) AND is_active = true`,
        [permissionIds],
      );
      const activePermissionIds = new Set(permCheck.rows.map((row) => Number(row.id)));
      const inactivePermissionIds = permissionIds.filter((pid) => !activePermissionIds.has(pid));
      if (inactivePermissionIds.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot assign inactive or missing permissions: ${inactivePermissionIds.join(', ')}.`,
        });
      }
    }

    await client.query(
      `UPDATE shiftly_schema.role_permissions SET is_active = false WHERE role_id = $1`,
      [roleId],
    );

    for (const pid of permissionIds) {
      await client.query(
        `INSERT INTO shiftly_schema.role_permissions(role_id, permission_id, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (role_id, permission_id)
         DO UPDATE SET is_active = true`,
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
