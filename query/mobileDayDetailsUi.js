
const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const userId = Number(req.query.user_id ?? req.query.userId);
    const rawDate = (req.query.date ?? '').toString().trim();

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user_id.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD).' });
    }

    const result = await pool.query(
      `SELECT shiftly_api.fn_mobile_day_details_ui($1::int, $2::date) AS payload`,
      [userId, rawDate],
    );

    if (!result.rows?.length) {
      return res.status(404).json({ error: 'No payload returned.' });
    }

    return res.json(result.rows[0].payload);
  } catch (err) {
    console.error('Error loading mobile day details UI:', err);
    return res.status(500).json({
      error: 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

module.exports = router;