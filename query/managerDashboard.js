
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
      example: '/dashboard/manager?userId=2',
    });
  }

  let sql = '';
  let values = [];

  if (from && to) {
    sql = `SELECT * FROM shiftly_api.fn_manager_dashboard($1::int, $2::date, $3::date);`;
    values = [userId, from, to];
  } else if (from && !to) {
    sql = `
      SELECT * FROM shiftly_api.fn_manager_dashboard(
        $1::int,
        $2::date,
        CURRENT_DATE + 1
      );
    `;
    values = [userId, from];
  } else if (!from && to) {
    sql = `
      SELECT * FROM shiftly_api.fn_manager_dashboard(
        $1::int,
        $2::date - (
          SELECT COALESCE(desktop_dashboard_default_days, 14)
          FROM shiftly_schema.system_configuration
          WHERE id = 1
        ),
        $2::date + 1
      );
    `;
    values = [userId, to];
  } else {
    sql = `SELECT * FROM shiftly_api.fn_manager_dashboard($1::int);`;
    values = [userId];
  }

  try {
    const baseResult = await pool.query(sql, values);
    const baseRow = baseResult.rows?.[0];
    if (!baseRow) {
      return res.status(404).json({
        error: 'Not found',
        message: `Manager ${userId} not found or no dashboard row returned.`,
      });
    }

    const rows = await pool.query(
      `
      SELECT
        $1::int AS manager_user_id,
        $2::text AS manager_user_name,
        $3::text AS manager_empno,
        $4::text AS manager_user_desc,
        $5::text AS manager_staff_type_name,
        $6::int[] AS linked_department_ids,
        $7::text[] AS linked_departments,
        $8::int[] AS linked_division_ids,
        $9::text[] AS linked_divisions,
        $10::int AS team_approved_shifts,
        $11::int AS team_pending_shifts,
        $12::int AS team_cancelled_shifts,
        $13::int AS team_total_shifts,
        $14::numeric AS team_approved_hours,
        to_char($15::date, 'YYYY-MM-DD') AS date_from,
        to_char($16::date, 'YYYY-MM-DD') AS date_to_inclusive,
        $17::int AS waiting_request_id,
        $18::text AS waiting_request_type,
        $19::text AS waiting_request_status,
        CASE
          WHEN $20::date IS NULL THEN NULL
          ELSE to_char($20::date, 'YYYY-MM-DD')
        END AS waiting_requested_shift_date,
        $21::int AS waiting_requested_by_user_id,
        $22::text AS waiting_requested_by_user_name,
        $23::int AS waiting_target_user_id,
        $24::text AS waiting_target_user_name,
        $25::text AS waiting_department_desc,
        $26::text AS waiting_division_desc,
        $27::text AS waiting_shift_label,
        $28::time AS waiting_shift_start_time,
        $29::time AS waiting_shift_end_time
      `,
      [
        baseRow.manager_user_id,
        baseRow.manager_user_name,
        baseRow.manager_empno,
        baseRow.manager_user_desc,
        baseRow.manager_staff_type_name,
        baseRow.linked_department_ids,
        baseRow.linked_departments,
        baseRow.linked_division_ids,
        baseRow.linked_divisions,
        baseRow.team_approved_shifts,
        baseRow.team_pending_shifts,
        baseRow.team_cancelled_shifts,
        baseRow.team_total_shifts,
        baseRow.team_approved_hours,
        baseRow.date_from,
        baseRow.date_to_inclusive,
        baseRow.waiting_request_id,
        baseRow.waiting_request_type,
        baseRow.waiting_request_status,
        baseRow.waiting_requested_shift_date,
        baseRow.waiting_requested_by_user_id,
        baseRow.waiting_requested_by_user_name,
        baseRow.waiting_target_user_id,
        baseRow.waiting_target_user_name,
        baseRow.waiting_department_desc,
        baseRow.waiting_division_desc,
        baseRow.waiting_shift_label,
        baseRow.waiting_shift_start_time,
        baseRow.waiting_shift_end_time,
      ]
    );

    if (!rows.rows || rows.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `Manager ${userId} not found or no dashboard row returned.`,
      });
    }

    return res.json(rows.rows[0]);
  } catch (err) {
    return sendDbError(res, err, 'managerDashboard');
  }
});

module.exports = router;
