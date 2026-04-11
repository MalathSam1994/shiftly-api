// query/mobileDashboard.js
// Read-only dashboard endpoint backed by: shiftly_api.fn_mobile_dashboard
//
// GET /dashboard/mobile?userId=2
// Optional:
//   &from=2026-01-01&to=2026-02-01
//
const express = require('express');
const pool = require('../db');

const router = express.Router();

function sendDbError(res, err, context) {
  const payload = {
    error: 'Database error',
    context: context || undefined,
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    constraint: err?.constraint,
    table: err?.table,
    column: err?.column,
    schema: err?.schema,
    routine: err?.routine,
    where: err?.where,
  };
  Object.keys(payload).forEach((k) => payload[k] == null && delete payload[k]);
  return res.status(500).json(payload);
}

function asIntOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function asDateStringOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Expect YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

router.get('/', async (req, res) => {
  const userId = asIntOrNull(req.query.userId);
  const from = asDateStringOrNull(req.query.from);
  const to = asDateStringOrNull(req.query.to);

  if (!userId) {
    return res.status(400).json({
      error: 'Missing required query params',
      required: ['userId'],
      example: '/dashboard/mobile?userId=2',
    });
  }

  let sql = '';
  let values = [];

  if (from && to) {
    sql = `SELECT * FROM shiftly_api.fn_mobile_dashboard($1::int, $2::date, $3::date);`;
    values = [userId, from, to];
  } else if (from && !to) {
    // If caller provides only "from", assume "to" = from + 1 month
    sql = `
      SELECT * FROM shiftly_api.fn_mobile_dashboard(
        $1::int,
        $2::date,
        (date_trunc('month', $2::date) + interval '1 month')::date
      );
    `;
    values = [userId, from];
  } else if (!from && to) {
    // If caller provides only "to", infer "from" from the month of (to - 1 day)
    sql = `
      SELECT * FROM shiftly_api.fn_mobile_dashboard(
        $1::int,
        date_trunc('month', ($2::date - interval '1 day'))::date,
        $2::date
      );
    `;
    values = [userId, to];
  } else {
    // No dates => function defaults to current month
    sql = `SELECT * FROM shiftly_api.fn_mobile_dashboard($1::int);`;
    values = [userId];
  }

  try {
    const baseResult = await pool.query(sql, values);
    const baseRow = baseResult.rows?.[0];
    if (!baseRow) {
      return res.status(404).json({
        error: 'Not found',
        message: `User ${userId} not found or no dashboard row returned.`,
      });
    }

    const rows = await pool.query(
      `
      SELECT
        $1::int AS user_id,
        $2::text AS user_name,
        $3::text AS empno,
        $4::text AS user_desc,
        $5::text AS staff_type_name,
        $6::int AS manager_user_id,
        $7::text AS manager_name,
        $8::int[] AS linked_division_ids,
        $9::text[] AS linked_divisions,
        $10::int[] AS linked_department_ids,
        $11::text[] AS linked_departments,
        $12::text[] AS worked_divisions_this_month,
        $13::text[] AS worked_departments_this_month,
        $14::int AS approved_shifts_this_month,
        $15::int AS canceled_shifts_this_month,
        $16::int AS pending_shifts_this_month,
        $17::int AS total_shifts_this_month,
        $18::int AS absence_shifts_this_month,
        $19::int AS days_worked_this_month,
        $20::numeric AS approved_hours_this_month,
        to_char($21::date, 'YYYY-MM-DD') AS month_from,
        to_char($22::date, 'YYYY-MM-DD') AS month_to_inclusive,
        $23::int AS next_shift_assignment_id,
        CASE WHEN $24::date IS NULL THEN NULL ELSE to_char($24::date, 'YYYY-MM-DD') END AS next_shift_date,
        $25::text AS next_shift_department_desc,
        $26::text AS next_shift_division_desc,
        $27::text AS next_shift_label,
        $28::time AS next_shift_start_time,
        $29::time AS next_shift_end_time,
        $30::numeric AS next_shift_duration_hours
      `,
      [
        baseRow.user_id,
        baseRow.user_name,
        baseRow.empno,
        baseRow.user_desc,
        baseRow.staff_type_name,
        baseRow.manager_user_id,
        baseRow.manager_name,
        baseRow.linked_division_ids,
        baseRow.linked_divisions,
        baseRow.linked_department_ids,
        baseRow.linked_departments,
        baseRow.worked_divisions_this_month,
        baseRow.worked_departments_this_month,
        baseRow.approved_shifts_this_month,
        baseRow.canceled_shifts_this_month,
        baseRow.pending_shifts_this_month,
        baseRow.total_shifts_this_month,
        baseRow.absence_shifts_this_month,
        baseRow.days_worked_this_month,
        baseRow.approved_hours_this_month,
        baseRow.month_from,
        baseRow.month_to_inclusive,
        baseRow.next_shift_assignment_id,
        baseRow.next_shift_date,
        baseRow.next_shift_department_desc,
        baseRow.next_shift_division_desc,
        baseRow.next_shift_label,
        baseRow.next_shift_start_time,
        baseRow.next_shift_end_time,
        baseRow.next_shift_duration_hours,
      ]
    );
    if (!rows.rows || rows.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `User ${userId} not found or no dashboard row returned.`,
      });
    }
 return res.json(rows.rows[0]);
  } catch (err) {
    return sendDbError(res, err, 'mobileDashboard');
  }
});

module.exports = router;