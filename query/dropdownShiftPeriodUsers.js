const express = require('express');
const pool = require('../db');

const router = express.Router();



function parseOptionalInt(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

async function queryWithTimeout(sql, params, timeoutMs = 20000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}


/**
 * GET /dropdown/shift-period-users
 *
 * Old simple mode:
 *   ?department_id=...&division_id=...
 *
 * New period-aware mode:
 *   ?department_id=...
 *   &division_id=...
 *   &staff_type_id=...
 *   &shift_period_id=...
 *   &shift_date=YYYY-MM-DD
 *   &shift_type_id=...              // optional, used for user-only edit mode
 *   &exclude_assignment_id=...      // optional, keep current row visible on edit
 *
 * Dedicated dropdown endpoint for Shift Periods screen only.
 * DB source of truth: shiftly_api.fn_dropdown_period_users(...)
 */
router.get('/', async (req, res) => {
  try {
    const rawDepartmentId = req.query.department_id ?? req.query.departmentId;
    const rawDivisionId = req.query.division_id ?? req.query.divisionId;
    const rawStaffTypeId = req.query.staff_type_id ?? req.query.staffTypeId;
    const rawShiftPeriodId =
      req.query.shift_period_id ?? req.query.shiftPeriodId;
    const rawShiftTypeId = req.query.shift_type_id ?? req.query.shiftTypeId;
    const rawExcludeAssignmentId =
      req.query.exclude_assignment_id ?? req.query.excludeAssignmentId;
    const rawShiftDate = req.query.shift_date ?? req.query.shiftDate;
    const departmentId =
      rawDepartmentId != null ? Number(rawDepartmentId) : null;
    const divisionId = parseOptionalInt(rawDivisionId);
    const staffTypeId = parseOptionalInt(rawStaffTypeId);
    const shiftPeriodId = parseOptionalInt(rawShiftPeriodId);
    const shiftTypeId = parseOptionalInt(rawShiftTypeId);
    const excludeAssignmentId = parseOptionalInt(rawExcludeAssignmentId);
    const shiftDate =
      rawShiftDate == null || `${rawShiftDate}`.trim() === ''
        ? null
        : `${rawShiftDate}`.trim();

    if (!Number.isFinite(departmentId)) {
      return res.status(400).json({
        error: 'department_id is required and must be numeric.',
      });
    }

    const isPeriodAwareMode =
      shiftPeriodId != null ||
      shiftDate != null ||
      shiftTypeId != null ||
      excludeAssignmentId != null ||
      staffTypeId != null;

    let sql;
    let params;

    if (isPeriodAwareMode) {
      if (shiftPeriodId == null || shiftDate == null) {
        return res.status(400).json({
          error:
            'period-aware mode requires shift_period_id and shift_date.',
        });
      }

      sql = `
        SELECT
          department_id,
          id,
          empno,
          user_name,
          user_desc,
          role_id,
          staff_type_id
        FROM shiftly_api.fn_dropdown_period_users($1, $2, $3, $4, $5::date, $6, $7)
      `;

      params = [
        departmentId,
        staffTypeId,
        divisionId,
        shiftPeriodId,
        shiftDate,
        shiftTypeId,
        excludeAssignmentId,
      ];
    } else {
      // backward-compatible simple mode
      params = [departmentId];
      let i = 2;

      sql = `
        SELECT DISTINCT
          division_id,
          department_id,
          id,
          empno,
          user_name,
          user_desc,
          role_id,
          staff_type_id
        FROM shiftly_schema.v_dropdown_dep_users_period
        WHERE department_id = $1
      `;

      if (Number.isFinite(divisionId)) {
        params.push(divisionId);
        sql += ` AND division_id = $${i++}`;
      }

      sql += ` ORDER BY user_name ASC, empno ASC, id ASC`;
    }

    console.log(
      `[${req.rid}] DROPDOWN shift-period-users sql=${sql.replace(/\s+/g, ' ').trim()}`
    );
    console.log(
      `[${req.rid}] DROPDOWN shift-period-users params=${JSON.stringify(params)}`
    );

    const result = await queryWithTimeout(sql, params, 20000);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error loading shift-period users dropdown:', err);
    return res.status(500).json({
      error: 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

module.exports = router;