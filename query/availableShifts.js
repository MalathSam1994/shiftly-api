// query/availableShifts.js
// GET /available-shifts?user_id=21&shift_date=2026-01-01
// Uses DB view: shiftly_schema.v_available_shifts

const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/', async (req, res) => {
  try {
    const qp = req.query || {};

    const rawUserId = qp.user_id ?? qp.userId;
    const userId =
      rawUserId != null && rawUserId !== '' ? Number(rawUserId) : null;

    const shiftDate = (qp.shift_date ?? qp.shiftDate ?? '').toString().trim();

    if (!userId || !Number.isFinite(userId)) {
      return res
        .status(400)
        .json({ error: 'user_id is required and must be a number' });
    }

    if (!shiftDate) {
      return res
        .status(400)
        .json({ error: 'shift_date is required (YYYY-MM-DD)' });
    }

   const sql = `
              SELECT *
                FROM shiftly_api.fn_available_shift_options($1::int, $2::date)
               `;

    const result = await pool.query(sql, [userId, shiftDate]);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /available-shifts failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;