// dropdownAbsenceTypes.js
// Read-only endpoint for mobile/web dropdowns.
// GET /dropdown/absence-types
const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const q = `
      SELECT code, description
        FROM shiftly_schema.absence_types
       WHERE is_active = TRUE
       ORDER BY sort_order ASC, code ASC
    `;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (err) {
    console.error('Error querying DB (DROPDOWN ABSENCE TYPES):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
