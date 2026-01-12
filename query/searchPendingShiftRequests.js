// query/searchPendingShiftRequests.js
// Read-only search endpoint backed by: shiftly_schema.vw_search_pending_shift_requests
//
// GET /search/pending-requests?userId=2&from=2026-01-01&to=2026-02-01&divisionId=&departmentId=&shiftTypeId=
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

router.get('/', async (req, res) => {
  const userId = asIntOrNull(req.query.userId);
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  const divisionId = asIntOrNull(req.query.divisionId);
  const departmentId = asIntOrNull(req.query.departmentId);
  const shiftTypeId = asIntOrNull(req.query.shiftTypeId);

  if (!userId || !from || !to) {
    return res.status(400).json({
      error: 'Missing required query params',
      required: ['userId', 'from', 'to'],
      example: '/search/pending-requests?userId=2&from=2026-01-01&to=2026-02-01',
    });
  }
  
   const reqDateExpr = `(requested_shift_date AT TIME ZONE 'Europe/Berlin')::date`;

  // Note: we keep the OR involvement filter, but we still keep the
  // date range + optional filters first to reduce scanned rows.
 const conditions = [
  `${reqDateExpr} >= $2::date`,
  `${reqDateExpr} <  $3::date`,
  `
  (
    requested_by_user_id = $1
    OR inbox_user_id      = $1
    OR target_user_id     = $1
    OR manager_user_id    = $1
  )
  `,
];

  const values = [userId, from, to];

  if (divisionId != null) {
    values.push(divisionId);
    conditions.push(`division_id = $${values.length}`);
  }
  if (departmentId != null) {
    values.push(departmentId);
    conditions.push(`requested_department_id = $${values.length}`);
  }
  if (shiftTypeId != null) {
    values.push(shiftTypeId);
    conditions.push(`requested_shift_type_id = $${values.length}`);
  }

  const sql = `
    SELECT 
	id,
  request_type,
  request_status,
 to_char(${reqDateExpr}, 'YYYY-MM-DD') AS requested_shift_date,
  requested_department_id,
  department_desc,
  division_id,
  division_desc,
  requested_shift_type_id,
  shift_label,
  start_time,
  end_time,
  requested_by_user_id,
  requested_by_name,
  target_user_id,
  target_user_name,
  manager_user_id,
  manager_name,
  inbox_user_id,
  inbox_user_name,
  shift_assignment_id,
  source_shift_assignment_id,
  target_shift_assignment_id,
  shift_offer_id,
  created_at,
  last_action_at,
  last_action_by_user_id,
  decision_by_user_id,
  decided_at,
  decision_comment,
  requested_absence_type
      FROM shiftly_schema.vw_search_pending_shift_requests
     WHERE ${conditions.join('\n       AND ')}
  ORDER BY ${reqDateExpr} ASC,
              last_action_at DESC NULLS LAST,
              created_at DESC
  `;

  try {
    const { rows } = await pool.query(sql, values);
    return res.json(rows);
  } catch (err) {
    return sendDbError(res, err, 'searchPendingShiftRequests');
  }
});

module.exports = router;
