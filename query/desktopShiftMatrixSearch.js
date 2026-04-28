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

  Object.keys(payload).forEach((key) => {
    if (payload[key] == null) delete payload[key];
  });

  return res.status(500).json(payload);
}

function asIntOrNull(value) {
  if (value == null) return null;

  const text = String(value).trim();
  if (!text) return null;

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asStringOrNull(value) {
  if (value == null) return null;

  const text = String(value).trim();
  return text ? text : null;
}

function asDateStringOrNull(value) {
  if (value == null) return null;

  const text = String(value).trim();
  if (!text) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  return text;
}

router.get('/', async (req, res) => {
  const requestedLoggedUserId = asIntOrNull(req.query.loggedUserId);
  const authenticatedUserId =
    asIntOrNull(req.user?.id) ||
    asIntOrNull(req.user?.user_id) ||
    asIntOrNull(req.auth?.id) ||
    asIntOrNull(req.auth?.user_id);

  const loggedUserId = authenticatedUserId || requestedLoggedUserId;

  const from = asDateStringOrNull(req.query.from);
  const to = asDateStringOrNull(req.query.to);

  const divisionId = asIntOrNull(req.query.divisionId);
  const departmentId = asIntOrNull(req.query.departmentId);
  const staffTypeId = asIntOrNull(req.query.staffTypeId);
  const shiftTypeId = asIntOrNull(req.query.shiftTypeId);
  const userId = asIntOrNull(req.query.userId);
  const status = asStringOrNull(req.query.status);

  if (!loggedUserId || !from || !to) {
    return res.status(400).json({
      error: 'Missing required query params',
      required: ['loggedUserId', 'from', 'to'],
      example:
        '/desktop-search/shift-matrix?loggedUserId=2&from=2026-05-01&to=2026-06-01',
    });
  }

  const sql = `
    SELECT
      shift_assignment_id,
      shift_period_id,
      to_char(shift_date, 'YYYY-MM-DD') AS shift_date,
      user_id,
      user_name,
      user_desc,
      empno,
      staff_type_id,
      staff_type_name,
      division_id,
      division_desc,
      department_id,
      department_desc,
      shift_type_id,
      shift_code,
      shift_label,
      start_time,
      end_time,
      duration_hours,
      status,
      source_type,
      is_absence,
      absence_type,
      can_include_all_shifts,
      data_scope
    FROM shiftly_api.fn_desktop_shift_matrix_search(
      $1::integer,
      $2::date,
      $3::date,
      $4::integer,
      $5::integer,
      $6::integer,
      $7::integer,
      $8::integer,
      $9::character varying
    )
  `;

  const values = [
    loggedUserId,
    from,
    to,
    divisionId,
    departmentId,
    staffTypeId,
    shiftTypeId,
    userId,
    status,
  ];

  try {
    const { rows } = await pool.query(sql, values);
    return res.json(rows);
  } catch (err) {
    return sendDbError(res, err, 'desktopShiftMatrixSearch');
  }
});

module.exports = router;