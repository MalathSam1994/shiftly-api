// routes/profile.js
// Self-service profile endpoints (mobile screen).
// IMPORTANT: This intentionally does NOT expose desktop/admin fields.

const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /profile -> current user's profile fields only
router.get('/', async (req, res) => {
  const userId = Number(req.user?.sub);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const q = `
      SELECT id,
             email,
             mobile_no,
             profile_photo,
             job_title,
             address1,
             address2,
             state,
             city,
             zip
      FROM shiftly_schema.users
      WHERE id = $1
    `;
    const r = await pool.query(q, [userId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error('PROFILE GET error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
});

// PUT /profile -> update current user's profile fields only
router.put('/', async (req, res) => {
  const userId = Number(req.user?.sub);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const {
    email,
    mobile_no,
    profile_photo,
    job_title,
    address1,
    address2,
    state,
    city,
    zip,
  } = req.body || {};

  try {
    const q = `
      UPDATE shiftly_schema.users
      SET email = $1,
          mobile_no = $2,
          profile_photo = $3,
          job_title = $4,
          address1 = $5,
          address2 = $6,
          state = $7,
          city = $8,
          zip = $9
      WHERE id = $10
      RETURNING id,
                email,
                mobile_no,
                profile_photo,
                job_title,
                address1,
                address2,
                state,
                city,
                zip
    `;
    const vals = [
      (email ?? null),
      (mobile_no ?? null),
      (profile_photo ?? null),
      (job_title ?? null),
      (address1 ?? null),
      (address2 ?? null),
      (state ?? null),
      (city ?? null),
      (zip ?? null),
      userId,
    ];

    const r = await pool.query(q, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error('PROFILE PUT error:', e);
    return res.status(500).json({ error: 'Database error' });
  }
});



// GET /profile/permissions -> list permission_key for current user (optional UI hints)
router.get('/permissions', async (req, res) => {
  try {
   const userId = Number(req.user?.sub);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sql = `
      SELECT DISTINCT p.permission_key
      FROM shiftly_schema.permissions p
      JOIN shiftly_schema.role_permissions rp ON rp.permission_id = p.id
      JOIN shiftly_schema.user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = $1
      UNION
      SELECT DISTINCT p.permission_key
      FROM shiftly_schema.permissions p
      JOIN shiftly_schema.role_permissions rp ON rp.permission_id = p.id
      JOIN shiftly_schema.users u ON u.role_id = rp.role_id
      WHERE u.id = $1 AND u.role_id IS NOT NULL
      ORDER BY permission_key
    `;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows.map(r => r.permission_key));
  } catch (e) {
    console.error('PROFILE PERMISSIONS error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});
 

module.exports = router;