const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/', async (req, res) => {
  try {
    const qp = req.query || {};

    const rawUserId = qp.user_id ?? qp.userId;
    const userId =
      rawUserId != null && rawUserId !== '' ? Number(rawUserId) : null;

    const monthStart = (qp.month_start ?? qp.monthStart ?? '').toString().trim();
    const today = (qp.today ?? '').toString().trim();

    if (!userId || !Number.isFinite(userId)) {
      return res
        .status(400)
        .json({ error: 'user_id is required and must be a number' });
    }

    if (!monthStart) {
      return res
        .status(400)
        .json({ error: 'month_start is required (YYYY-MM-DD)' });
    }

    const sql = `
      SELECT *
        FROM shiftly_api.fn_mobile_calendar_day_states(
          $1::int,
          $2::date,
         CASE WHEN NULLIF($3::text, '') IS NULL THEN NULL ELSE $3::date END
        )
    `;

    const result = await pool.query(sql, [userId, monthStart, today || null]);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /mobile-calendar/day-states failed:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
    });
  }
});

module.exports = router;