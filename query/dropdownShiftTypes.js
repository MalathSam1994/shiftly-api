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

// GET /dropdown/shift-types
router.get('/', async (req, res) => {
  try {
    const depRaw = req.query.department_id;
    const staffRaw = req.query.staff_type_id;
    const divRaw = req.query.division_id;
    const userId = parseOptionalInt(req.query.user_id);
    const templateId = parseOptionalInt(req.query.template_id);
    const dayOfWeek = parseOptionalInt(req.query.day_of_week);
    const weekOfCycle = parseOptionalInt(req.query.week_of_cycle);
    const excludeEntryId = parseOptionalInt(req.query.exclude_entry_id);
    const shiftPeriodId = parseOptionalInt(req.query.shift_period_id);
    const excludeAssignmentId = parseOptionalInt(req.query.exclude_assignment_id);
    const shiftDateRaw = req.query.shift_date;
    const shiftDate =
      shiftDateRaw == null || `${shiftDateRaw}`.trim() === ''
        ? null
        : `${shiftDateRaw}`.trim();
    const hasDep = depRaw != null && `${depRaw}`.trim() !== '';
    const hasStaff = staffRaw != null && `${staffRaw}`.trim() !== '';

const divisionId = parseOptionalInt(divRaw);
    // If called WITHOUT params (e.g. app bootstrap), return a global list of shift types.
    // This prevents 400s like:
    //   /dropdown/shift-types status=400 Missing/invalid query params...
    //
    // If exactly one of the required params is provided -> keep strict 400.
    if (!hasDep && !hasStaff) {
      const sqlAll = `
        SELECT
          st.id AS id,
          st.id AS shift_type_id,
          st.shift_code,
          st.shift_label,
          st.start_time,
          st.end_time,
          st.duration_hours,
          COALESCE(st.day_type, 'ANY'::character varying) AS day_type,
          st.notes
        FROM shiftly_schema.shift_types st
        ORDER BY st.shift_label, st.shift_code
      `;

      console.log(
        `[${req.rid}] DROPDOWN shift-types (global) sql=${sqlAll
          .replace(/\s+/g, ' ')
          .trim()}`
      );

      const result = await queryWithTimeout(sqlAll, [], 20000);
      return res.json(result.rows);
    }

    if (!hasDep || !hasStaff) {
      return res.status(400).json({
        error:
          'Missing/invalid query params. Required together: department_id, staff_type_id. Optional: division_id',
      });
    }

    const departmentId = parseInt(depRaw, 10);
    const staffTypeId = parseInt(staffRaw, 10);

    if (!Number.isInteger(departmentId) || !Number.isInteger(staffTypeId)) {
      return res.status(400).json({
        error:
          'Missing/invalid query params. Required together: department_id, staff_type_id. Optional: division_id',
      });
    }

    const isTemplateMode =
      templateId != null || dayOfWeek != null || weekOfCycle != null || excludeEntryId != null;

    const isPeriodMode =
      shiftPeriodId != null || shiftDate != null;

    if (isTemplateMode) {
      if (templateId == null || dayOfWeek == null || weekOfCycle == null) {
        return res.status(400).json({
          error: 'template mode requires template_id, day_of_week, and week_of_cycle',
        });
      }

      const sql = `
        SELECT
          rule_id,
          division_id,
          department_id,
          staff_type_id,
          id,
          shift_type_id,
          shift_code,
          shift_label,
          start_time,
          end_time,
          duration_hours,
          day_type,
          notes,
          required_staff_count
        FROM shiftly_api.fn_dropdown_template_shift_types($1, $2, $3, $4, $5, $6, $7, $8)
      `;

      const params = [
        departmentId,
        staffTypeId,
        divisionId,
        userId,
        templateId,
        dayOfWeek,
        weekOfCycle,
        excludeEntryId,
      ];

      console.log(
        `[${req.rid}] DROPDOWN shift-types (template) params=${JSON.stringify(params)}`
      );

      const result = await queryWithTimeout(sql, params, 20000);
      return res.json(result.rows);
    }

    if (isPeriodMode) {
      if (shiftPeriodId == null || !shiftDate) {
        return res.status(400).json({
          error: 'period mode requires shift_period_id and shift_date',
        });
      }

      const sql = `
        SELECT
          rule_id,
          division_id,
          department_id,
          staff_type_id,
          id,
          shift_type_id,
          shift_code,
          shift_label,
          start_time,
          end_time,
          duration_hours,
          day_type,
          notes,
          required_staff_count
        FROM shiftly_api.fn_dropdown_period_shift_types($1, $2, $3, $4, $5, $6::date, $7)
      `;

      const params = [
        departmentId,
        staffTypeId,
        divisionId,
        userId,
        shiftPeriodId,
        shiftDate,
        excludeAssignmentId,
      ];

      console.log(
        `[${req.rid}] DROPDOWN shift-types (period) params=${JSON.stringify(params)}`
      );

      const result = await queryWithTimeout(sql, params, 20000);
      return res.json(result.rows);
    }



    const sql = `
      SELECT DISTINCT ON (shift_type_id)
        rule_id,
        division_id,
        department_id,
        staff_type_id,
        shift_type_id AS id,
        shift_type_id,
        shift_code,
        shift_label,
        start_time,
        end_time,
        duration_hours,
        day_type,
        notes,
        required_staff_count
      FROM shiftly_schema.v_dropdown_shift_types
      WHERE
        (division_id IS NULL OR division_id = $1)
        AND department_id = $2
        AND staff_type_id = $3
      -- Prefer division-specific rule over division_id IS NULL (global) when both exist
      ORDER BY shift_type_id, (division_id IS NULL) ASC, shift_label, shift_code
    `;

    console.log(
      `[${req.rid}] DROPDOWN shift-types div=${divisionId} dep=${departmentId} staff=${staffTypeId} sql=${sql
        .replace(/\s+/g, ' ')
        .trim()}`
    );

    const result = await queryWithTimeout(
      sql,
      [divisionId, departmentId, staffTypeId],
      20000
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(`[${req.rid}] Error querying DB (DROPDOWN SHIFT TYPES):`, err);
    return res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;