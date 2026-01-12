// query/searchAvailableShifts.js
// Read-only search endpoint backed by: shiftly_schema.vw_search_available_shifts
//
// GET /search/available-shifts?userId=2&from=2026-01-01&to=2026-02-01&divisionId=&departmentId=&shiftTypeId=
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
      example:
        '/search/available-shifts?userId=2&from=2026-01-01&to=2026-02-01',
    });
  }
  
  // Use local-calendar date for filtering and output (fixes "2025-12-31" instead of "2026-01-01").
// Works when vw exposes shift_date as timestamptz/ts; we always compare by Berlin date.
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
        user_id,
        to_char(${shiftDateExpr}, 'YYYY-MM-DD') AS shift_date,
        department_id,
        department_desc,
        division_id,
        division_desc,
        shift_type_id,
        shift_label,
        start_time,
        end_time,
        duration_hours,
        required_staff_count,
        assigned_count,
        free_slots,
        user_has_assigned_shift
      FROM shiftly_schema.vw_search_available_shifts
     WHERE ${conditions.join('\n       AND ')}
      ORDER BY ${shiftDateExpr} ASC, division_id ASC, department_id ASC, shift_type_id ASC
  `;

  try {
    const { rows } = await pool.query(sql, values);
    return res.json(rows);
  } catch (err) {
    return sendDbError(res, err, 'searchAvailableShifts');
  }
});

module.exports = router;
