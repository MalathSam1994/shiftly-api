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
    // IMPORTANT:
    // Do NOT return PostgreSQL DATE columns as raw JS Date objects here.
    // node-postgres may materialize DATE into a JS Date and JSON-serialize it
    // with a timezone offset, which can visually shift 2026-04-15 -> 2026-04-14
    // on the Flutter side depending on local/server timezone.
    //
    // Always stringify business dates explicitly as YYYY-MM-DD.
    const sql = `
      SELECT
        to_char(x.calendar_date, 'YYYY-MM-DD') AS calendar_date,
        x.background_code,
        x.dot_code,
        x.tooltip,
        x.is_clickable,
        x.tap_action,
        x.is_public_holiday,
        x.holiday_occasion,
        x.is_today,
        x.is_past_date,
        x.user_has_any_assignment,
        x.user_has_blue_assignment,
        x.user_has_absence_row,
        x.user_absence_type,
        x.has_pending_request,
        x.has_cancelled_request,
        x.cancelled_and_pending,
        x.user_has_approved_assignment,
        x.user_has_approved_shift,
        x.avail_has_any_shifts,
        x.avail_any_capacity_set,
        x.avail_has_free_slot,
        x.avail_user_has_assigned_shift,
        x.is_requestable_visual,
        x.reason_code,
        x.reason_detail
      FROM shiftly_api.fn_mobile_calendar_day_states(
        $1::int,
        $2::date,
        CASE WHEN NULLIF($3::text, '') IS NULL THEN NULL ELSE $3::date END
      ) x
      ORDER BY x.calendar_date
    `;

    const result = await pool.query(sql, [userId, monthStart, today || null]);

    // DEBUG:
    // Helps verify whether the server returns the correct business day strings.
    console.log('[mobile-calendar/day-states] request', {
      userId,
      monthStart,
      today: today || null,
      serverTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sample: result.rows.slice(0, 5).map((r) => ({
        calendar_date: r.calendar_date,
        background_code: r.background_code,
        dot_code: r.dot_code,
        tap_action: r.tap_action,
        reason_code: r.reason_code,
      })),
    });

  
  
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