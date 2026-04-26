// query/shiftAssignmentHistory.js
// Read-only history endpoint backed by:
// shiftly_api.fn_search_shift_assignment_history
//
// GET /search/shift-assignment-history
//
// Optional query params:
//   shiftDateFrom=2026-05-01
//   shiftDateTo=2026-06-01
//   assignmentUserDesc=Hamzah
//   changeReason=SWITCH
//   divisionDesc=St Johns
//   departmentDesc=ICU
//   staffTypeName=RN
//   shiftTypeDesc=Night
//   limit=20
//   offset=0

const express = require('express');
const pool = require('../db');

const router = express.Router();

function sendDbError(res, err, context) {
  const payload = {
    error: 'Database error',
    context: context || undefined,
    message: err && err.message,
    code: err && err.code,
    detail: err && err.detail,
    constraint: err && err.constraint,
    table: err && err.table,
    column: err && err.column,
    schema: err && err.schema,
    routine: err && err.routine,
    where: err && err.where,
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] == null) {
      delete payload[key];
    }
  });

  return res.status(500).json(payload);
}

function asTextOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

function asIntWithDefault(value, defaultValue) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return parsed;
}


function asIntOrNull(value) {
  if (value == null || String(value).trim() === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function asDateOrNull(value) {
  const text = asTextOrNull(value);
  if (!text) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  return text;
}

router.get('/', async (req, res) => {
  const shiftDateFrom = asDateOrNull(req.query.shiftDateFrom);
  const shiftDateTo = asDateOrNull(req.query.shiftDateTo);

  const assignmentUserDesc = asTextOrNull(req.query.assignmentUserDesc);
  const assignmentUserId = asIntOrNull(req.query.assignmentUserId);
  const changeReason = asTextOrNull(req.query.changeReason);
  const divisionDesc = asTextOrNull(req.query.divisionDesc);
  const departmentDesc = asTextOrNull(req.query.departmentDesc);
  const staffTypeName = asTextOrNull(req.query.staffTypeName);
  const shiftTypeDesc = asTextOrNull(req.query.shiftTypeDesc);

  const rawLimit = asIntWithDefault(req.query.limit, 20);
  const rawOffset = asIntWithDefault(req.query.offset, 0);

  const limit = Math.min(Math.max(rawLimit, 1), 100);
  const offset = Math.max(rawOffset, 0);

  if (req.query.shiftDateFrom && !shiftDateFrom) {
    return res.status(400).json({
      error: 'Invalid shiftDateFrom. Expected YYYY-MM-DD.',
    });
  }


  if (req.query.assignmentUserId && assignmentUserId == null) {
    return res.status(400).json({
      error: 'Invalid assignmentUserId. Expected integer.',
    });
  }

  if (req.query.shiftDateTo && !shiftDateTo) {
    return res.status(400).json({
      error: 'Invalid shiftDateTo. Expected YYYY-MM-DD.',
    });
  }

  const sql = `
    SELECT
      total_count,

      history_id,
      to_char(history_shift_date, 'YYYY-MM-DD') AS history_shift_date,
      changed_at,
      shift_assignment_id,

      assignment_user_id,
      assignment_user_desc,

      history_comment,
      change_reason,

      history_division_id,
      history_division_desc,

      history_department_id,
      history_department_desc,

      history_shift_type_id,
      history_shift_label,
      to_char(history_shift_start_time, 'HH24:MI') AS history_shift_start_time,
      to_char(history_shift_end_time, 'HH24:MI') AS history_shift_end_time,
      history_shift_duration_hours,

      assignment_staff_type_id,
      assignment_staff_type_name,

      assignment_absence_type_code,
      assignment_absence_type_desc,

      request_id,
      request_decision_comment,
      requested_by_user_id,
      requested_by_user_desc,

      offer_id,
      offer_status_code,
      offer_offered_by_user_id,
      offer_offered_by_user_desc,
      offer_taken_by_user_id,
      offer_taken_by_user_desc

    FROM shiftly_api.fn_search_shift_assignment_history(
      $1::date,
      $2::date,
      $3::text,
      $4::text,
      $5::text,
      $6::text,
      $7::text,
      $8::text,
      $9::integer,
      $10::integer,
      $11::integer
    )
  `;

  const values = [
    shiftDateFrom,
    shiftDateTo,
    assignmentUserDesc,
    changeReason,
    divisionDesc,
    departmentDesc,
    staffTypeName,
    shiftTypeDesc,
    limit,
    offset,
    assignmentUserId,
  ];

  try {
    const result = await pool.query(sql, values);

    const totalCount =
      result.rows.length > 0 && result.rows[0].total_count != null
        ? Number(result.rows[0].total_count)
        : 0;

    return res.json({
      totalCount,
      limit,
      offset,
      rows: result.rows,
    });
  } catch (err) {
    return sendDbError(res, err, 'shiftAssignmentHistory');
  }
});

module.exports = router;