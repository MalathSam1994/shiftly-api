// routes/permissions.js
const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /permissions -> list all permissions (for Roles screen)
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT id, permission_key, permission_desc
      FROM shiftly_schema.permissions
      ORDER BY permission_key
    `;
    const result = await pool.query(sql, []);
    res.json(result.rows);
  } catch (e) {
    console.error('PERMISSIONS LIST error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});


// POST /permissions -> create
router.post('/', async (req, res) => {
  const { permission_key, permission_desc } = req.body || {};
  const key = String(permission_key || '').trim();
  const desc = permission_desc == null ? null : String(permission_desc);
  if (!key) return res.status(400).json({ error: 'permission_key is required' });

  try {
    const q = `
      INSERT INTO shiftly_schema.permissions(permission_key, permission_desc)
      VALUES ($1, $2)
      RETURNING id, permission_key, permission_desc
    `;
    const r = await pool.query(q, [key, desc]);
    return res.status(201).json(r.rows[0]);
  } catch (e) {
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

  const { permission_key, permission_desc } = req.body || {};
  const key = String(permission_key || '').trim();
  const desc = permission_desc == null ? null : String(permission_desc);
  if (!key) return res.status(400).json({ error: 'permission_key is required' });

  try {
    const q = `
      UPDATE shiftly_schema.permissions
      SET permission_key = $1,
          permission_desc = $2
      WHERE id = $3
      RETURNING id, permission_key, permission_desc
    `;
    const r = await pool.query(q, [key, desc, id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (e) {
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