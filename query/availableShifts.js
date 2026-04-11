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

    // IMPORTANT:
    // Do NOT return PostgreSQL DATE columns as raw JS Date objects here.
    // Always stringify business dates explicitly as YYYY-MM-DD to avoid
    // timezone-based off-by-one shifts in JSON.
    const sql = `
      SELECT
        x.option_id,
        x.user_id,
        to_char(x.shift_date, 'YYYY-MM-DD') AS shift_date,
        x.department_id,
        x.department_desc,
        x.staff_type_id,
        x.staff_type_name,
        x.division_id,
        x.division_desc,
        x.shift_type_id,
        x.shift_label,
        x.start_time,
        x.end_time,
        x.duration_hours,
        x.required_staff_count,
        x.assigned_count,
        x.free_slots,
        x.user_has_assigned_shift,
        x.can_request_new_shift,
        x.blocked_reason,
        x.is_offered,
        x.offer_id,
        x.offer_assignment_id,
        x.offered_by_user_id,
        x.offer_note
      FROM shiftly_api.fn_available_shift_options($1::int, $2::date) x
      ORDER BY x.is_offered DESC, x.division_id ASC, x.department_id ASC, x.shift_type_id ASC
    `;

    const result = await pool.query(sql, [userId, shiftDate]);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /available-shifts failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;