// routes/userRoles.js
// User <-> Role mapping (for admin "Roles" screen)
const express = require('express');
const pool = require('../db');
const {
  activeStatusSql,
  parseActiveStatusQuery,
  parseOptionalBoolean,
  sendActiveStatusError,
} = require('../utils/activeStatus');
const router = express.Router();

// PATCH /user-roles/mapping/:id/status
// body: { is_active: boolean }
router.patch('/mapping/:id/status', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid user role mapping id.' });
    }

    const isActive = parseOptionalBoolean(req.body?.is_active, 'is_active');
    if (isActive == null) {
      return res.status(400).json({ error: 'is_active is required.' });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT ur.id, ur.user_id, ur.role_id, u.is_active AS user_is_active,
              r.is_active AS role_is_active
       FROM shiftly_schema.user_roles ur
       JOIN shiftly_schema.users u ON u.id = ur.user_id
       JOIN shiftly_schema.roles r ON r.id = ur.role_id
       WHERE ur.id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User role mapping not found.' });
    }

    const row = existing.rows[0];
    if (isActive && (!row.user_is_active || !row.role_is_active)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Cannot reactivate a user role mapping with an inactive user or role.',
      });
    }

    const result = await client.query(
      `UPDATE shiftly_schema.user_roles
       SET is_active = $1
       WHERE id = $2
       RETURNING id, user_id, role_id, is_primary, is_active`,
      [isActive, id]
    );

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendActiveStatusError(res, e)) return;
    console.error('USER ROLES STATUS error:', e);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// GET /user-roles/:userId
router.get('/:userId', async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const active = activeStatusSql(parseActiveStatusQuery(req.query), 'ur.is_active', 2);
    const activeClause = active.clause ? `AND ${active.clause}` : '';

    const sql = `
      SELECT ur.id, ur.user_id, ur.role_id, ur.is_primary, ur.is_active,
             r.role_code, r.role_name
      FROM shiftly_schema.user_roles ur
      JOIN shiftly_schema.roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ${activeClause}
      ORDER BY ur.is_primary DESC, r.role_code
    `;
    const result = await pool.query(sql, [userId, ...active.params]);
    res.json(result.rows);
  } catch (e) {
    if (sendActiveStatusError(res, e)) return;
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
    const userCheck = await client.query(
      `SELECT id FROM shiftly_schema.users WHERE id = $1 AND is_active = true`,
      [userId]
    );
    if (userCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot assign roles to an inactive or missing user.' });
    }

    if (roleIds.length > 0) {
      const roleCheck = await client.query(
        `SELECT id FROM shiftly_schema.roles WHERE id = ANY($1::int[]) AND is_active = true`,
        [roleIds]
      );
      const activeRoleIds = new Set(roleCheck.rows.map((row) => Number(row.id)));
      const inactiveRoleIds = roleIds.filter((rid) => !activeRoleIds.has(rid));
      if (inactiveRoleIds.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot assign inactive or missing roles: ${inactiveRoleIds.join(', ')}.`,
        });
      }
    }

    await client.query(`UPDATE shiftly_schema.user_roles SET is_active = false WHERE user_id = $1`, [userId]);

    for (const rid of roleIds) {
      const isPrimary = primaryRoleId != null && rid === primaryRoleId;
      await client.query(
        `INSERT INTO shiftly_schema.user_roles(user_id, role_id, is_primary, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id, role_id)
         DO UPDATE SET is_primary = EXCLUDED.is_primary, is_active = true`,
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
