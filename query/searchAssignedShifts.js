// query/searchAssignedShifts.js
// Read-only search endpoint backed by: shiftly_schema.vw_search_user_assigned_shifts
//
// GET /search/assigned-shifts?userId=2&from=2026-01-01&to=2026-02-01&divisionId=&departmentId=&shiftTypeId=
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
      example: '/search/assigned-shifts?userId=2&from=2026-01-01&to=2026-02-01',
    });
  }
  
   const shiftDateExpr = `(shift_date AT TIME ZONE 'Europe/Berlin')::date`;

  const conditions = [
    'user_id = $1',
     `${shiftDateExpr} >= $2::date`,
   `${shiftDateExpr} <  $3::date`,
  ];
  const values = [userId, from, to];

  if (divisionId != null) {
    values.push(divisionId);
    conditions.push(`division_id = $${values.length}`);
  }
  if (departmentId != null) {
    values.push(departmentId);
    conditions.push(`department_id = $${values.length}`);
  }
  if (shiftTypeId != null) {
    values.push(shiftTypeId);
    conditions.push(`shift_type_id = $${values.length}`);
  }

  const sql = `
    SELECT 
		id,
   shift_period_id,
    to_char(${shiftDateExpr}, 'YYYY-MM-DD') AS shift_date,
   department_id,
   department_desc,
   division_id,
   division_desc,
   user_id,
   staff_type_id,
   shift_type_id,
   shift_label,
   start_time,
   end_time,
   duration_hours,
   status,
   source_type,
   is_absence,
   absence_type,
   created_at,
   updated_at
      FROM shiftly_schema.vw_search_user_assigned_shifts
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY ${shiftDateExpr} ASC
  `;

  try {
    const { rows } = await pool.query(sql, values);
    return res.json(rows);
  } catch (err) {
    return sendDbError(res, err, 'searchAssignedShifts');
  }
});

module.exports = router;
