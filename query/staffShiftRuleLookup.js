const express = require('express');
const pool = require('../db');

const router = express.Router();

// Run a single query with a per-request statement_timeout that does NOT leak to pooled sessions.
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

// GET /rules/staff-shift-rule
// Query params:
//   required: department_id, staff_type_id, shift_type_id
//   optional: division_id
//
// Returns:
//   {
//     exists: boolean,
//     rule_id: number|null,
//     required_staff_count: number|null,
//     scope: "DIVISION"|"GLOBAL"|"FALLBACK_ANY"|"NONE"
//   }
router.get('/', async (req, res) => {
  try {
    const depRaw = req.query.department_id;
    const staffRaw = req.query.staff_type_id;
    const shiftRaw = req.query.shift_type_id;
    const divRaw = req.query.division_id;

    const hasDep = depRaw != null && `${depRaw}`.trim() !== '';
    const hasStaff = staffRaw != null && `${staffRaw}`.trim() !== '';
    const hasShift = shiftRaw != null && `${shiftRaw}`.trim() !== '';

    if (!hasDep || !hasStaff || !hasShift) {
      return res.status(400).json({
        error:
          'Missing/invalid query params. Required: department_id, staff_type_id, shift_type_id. Optional: division_id',
      });
    }

    const departmentId = parseInt(depRaw, 10);
    const staffTypeId = parseInt(staffRaw, 10);
    const shiftTypeId = parseInt(shiftRaw, 10);
    const divisionId =
      divRaw == null || `${divRaw}`.trim() === '' ? null : parseInt(divRaw, 10);

    if (
      !Number.isInteger(departmentId) ||
      !Number.isInteger(staffTypeId) ||
      !Number.isInteger(shiftTypeId) ||
      (divisionId != null && !Number.isInteger(divisionId))
    ) {
      return res.status(400).json({
        error:
          'Missing/invalid query params. Required: department_id, staff_type_id, shift_type_id. Optional: division_id',
      });
    }

    const sql = `
      SELECT
        existing AS exists,
        rule_id,
        required_staff_count,
        scope
      FROM shiftly_schema.fn_staff_shift_rule_lookup($1, $2, $3, $4)
    `;

    console.log(
      `[${req.rid}] RULE LOOKUP div=${divisionId} dep=${departmentId} staff=${staffTypeId} shift=${shiftTypeId} sql=${sql
        .replace(/\s+/g, ' ')
        .trim()}`
    );

    const result = await queryWithTimeout(
      sql,
      [divisionId, departmentId, staffTypeId, shiftTypeId],
      20000
    );

    // Function always returns exactly 1 row, but be defensive.
    const row = result.rows?.[0];
    if (!row) {
      return res.json({
        exists: false,
        rule_id: null,
        required_staff_count: null,
        scope: 'NONE',
      });
    }

    return res.json(row);
  } catch (err) {
    console.error(`[${req.rid}] Error querying DB (RULE LOOKUP):`, err);
    // Include a little more detail to help the client show meaningful info.
    // (If you consider this too verbose for prod, guard it behind an env flag.)
    return res.status(500).json({
      error: 'Database error',
      details: err?.message ? String(err.message) : String(err),
      rid: req.rid,
    });
  }
});

module.exports = router;
