const express = require('express');
const pool = require('../db');

const router = express.Router();

/**
 * GET /dropdown/shift-period-users?department_id=...&division_id=...
 *
 * Dedicated dropdown endpoint for Shift Periods screen only.
 * Backed by: shiftly_schema.v_dropdown_dep_users_period
 *
 * Keeps the old /dropdown/users endpoint untouched for other screens.
 */
router.get('/', async (req, res) => {
  try {
    const rawDepartmentId = req.query.department_id ?? req.query.departmentId;
    const rawDivisionId = req.query.division_id ?? req.query.divisionId;

    const departmentId =
      rawDepartmentId != null ? Number(rawDepartmentId) : null;
    const divisionId =
      rawDivisionId != null && rawDivisionId !== ''
        ? Number(rawDivisionId)
        : null;

    if (!Number.isFinite(departmentId)) {
      return res.status(400).json({
        error: 'department_id is required and must be numeric.',
      });
    }

    const params = [departmentId];
    let i = 2;

    let sql = `
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

    const result = await pool.query(sql, params);
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