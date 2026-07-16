// routes/permissions.js
const express = require('express');
const pool = require('../db');
const {
  activeStatusSql,
  parseActiveStatusQuery,
  parseCreateIsActive,
  parseOptionalBoolean,
  sendActiveStatusError,
} = require('../utils/activeStatus');
const router = express.Router();

// GET /permissions -> list all permissions (for Roles screen)
router.get('/', async (req, res) => {
  try {
    const active = activeStatusSql(parseActiveStatusQuery(req.query), 'is_active', 1);
    const where = active.clause ? `WHERE ${active.clause}` : '';

    const sql = `
      SELECT id, permission_key, permission_desc, is_active
      FROM shiftly_schema.permissions
      ${where}
      ORDER BY permission_key
    `;
    const result = await pool.query(sql, active.params);
    res.json(result.rows);
  } catch (e) {
    if (sendActiveStatusError(res, e)) return;
    console.error('PERMISSIONS LIST error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});


// POST /permissions -> create
router.post('/', async (req, res) => {
  const { permission_key, permission_desc, is_active } = req.body || {};
  const key = String(permission_key || '').trim();
  const desc = permission_desc == null ? null : String(permission_desc);
  if (!key) return res.status(400).json({ error: 'permission_key is required' });

  try {
    const isActive = parseCreateIsActive({ is_active });
    const q = `
      INSERT INTO shiftly_schema.permissions(permission_key, permission_desc, is_active)
      VALUES ($1, $2, $3)
      RETURNING id, permission_key, permission_desc, is_active
    `;
    const r = await pool.query(q, [key, desc, isActive]);
    return res.status(201).json(r.rows[0]);
  } catch (e) {
    if (sendActiveStatusError(res, e)) return;
    // Unique violation
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'permission_key already exists' });
    }
    console.error('PERMISSIONS CREATE error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
});

// PUT /permissions/:id -> update
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const { permission_key, permission_desc, is_active } = req.body || {};
  const key = String(permission_key || '').trim();
  const desc = permission_desc == null ? null : String(permission_desc);
  if (!key) return res.status(400).json({ error: 'permission_key is required' });

  try {
    const parsedIsActive = parseOptionalBoolean(is_active, 'is_active');
    const sets = ['permission_key = $1', 'permission_desc = $2'];
    const values = [key, desc];
    let nextIndex = 3;

    if (parsedIsActive !== undefined) {
      sets.push(`is_active = $${nextIndex}`);
      values.push(parsedIsActive);
      nextIndex += 1;
    }

    values.push(id);

    const q = `
      UPDATE shiftly_schema.permissions
      SET ${sets.join(', ')}
      WHERE id = $${nextIndex}
      RETURNING id, permission_key, permission_desc, is_active
    `;
    const r = await pool.query(q, values);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (e) {
    if (sendActiveStatusError(res, e)) return;
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'permission_key already exists' });
    }
    console.error('PERMISSIONS UPDATE error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /permissions/:id -> delete
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const q = `
      DELETE FROM shiftly_schema.permissions
      WHERE id = $1
      RETURNING id, permission_key
    `;
    const r = await pool.query(q, [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, deleted: r.rows[0] });
  } catch (e) {
    console.error('PERMISSIONS DELETE error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
});


module.exports = router;
