// routes/shiftPeriods.js
const express = require('express');
const pool = require('../db');
const createCrudRouter = require('../createCrudRouter');

const shiftPeriodsConfig = {
  table: 'shiftly_schema.shift_periods',
  idColumn: 'id',
  columns: [
    'period_type',
    'start_date',
    'end_date',
    'template_id',
    'generated_at',
    'generated_by_user_id',
    'status',
    'description',
  ],
};
const router = createCrudRouter(shiftPeriodsConfig);

/**
 * Helper: convert JS Date -> ISO YYYY-MM-DD (no time part)
 */
function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Helper: Monday = 1, Sunday = 7
 */
function isoWeekday(date) {
  const jsDay = date.getDay(); // 0..6, Sunday = 0
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Helper: week index in month, 1-based (1..4/5)
 * Same logic as in Flutter: ((day-1) ~/ 7) + 1
 */
function weekIndexInMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

/**
 * Helper: normalize week_of_cycle for multi-week patterns
 */
function weekOfCycleForDate(date, cycleLengthWeeks) {
  const index = weekIndexInMonth(date);
  const length = cycleLengthWeeks && cycleLengthWeeks > 0
    ? cycleLengthWeeks
    : 1;
  return ((index - 1) % length) + 1;
}

/**
 * Pick the best StaffShiftRule:
 *  - exact division match first
 *  - else global rule (division_id null)
 *  - else null
 */
function findBestStaffShiftRule(rules, { divisionId, departmentId, staffTypeId, shiftTypeId }) {
  let exact = null;
  let global = null;

  for (const r of rules) {
    const baseMatch =
      r.department_id === departmentId &&
      r.staff_type_id === staffTypeId &&
      r.shift_type_id === shiftTypeId;
    if (!baseMatch) continue;

    if (divisionId != null && r.division_id === divisionId) {
      exact = exact ?? r;
    } else if (r.division_id == null) {
      global = global ?? r;
    }
  }

  return exact ?? global;
}


/**
 * POST /shift-periods/:id/generate-from-template
 *
 * This endpoint:
 *   1) Loads the shift_period and its template_id
 *   2) Loads the template + template entries
 *   3) Deletes existing TEMPLATE-based assignments for this period
 *   4) Loops over all days in the period and inserts shift_assignments
 *      wherever the (day_of_week, week_of_cycle) from the template matches.
 *
 * Expected DB columns (aligned with the Flutter models):
 *   shift_templates:
 *     - id
 *     - pattern_type         ('WEEKLY' or 'WEEKLY_CYCLE')
 *     - cycle_length_weeks   (integer)
 *   shift_template_entries:
 *     - template_id
 *     - department_id
 *     - staff_type_id
 *     - user_id
 *     - shift_type_id
 *     - day_of_week          (1..7, Monday = 1)
 *     - week_of_cycle        (1..N, for WEEKLY_CYCLE; for WEEKLY typically 1)
 */
router.post('/:id/generate-from-template', async (req, res) => {
  const periodId = parseInt(req.params.id, 10);

  if (Number.isNaN(periodId)) {
    return res.status(400).json({ error: 'Invalid period id.' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) Load the shift_period
    const periodQuery = `
      SELECT *
      FROM shiftly_schema.shift_periods
      WHERE id = $1
      FOR UPDATE
    `;
    const periodResult = await client.query(periodQuery, [periodId]);

    if (periodResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift period not found.' });
    }

    const period = periodResult.rows[0];

    if (!period.template_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Shift period has no template_id. Nothing to generate from.',
      });
    }

    // 2) Load the template
    const templateQuery = `
      SELECT id, pattern_type, cycle_length_weeks
      FROM shiftly_schema.shift_templates
      WHERE id = $1
    `;
    const templateResult = await client.query(templateQuery, [
      period.template_id,
    ]);

    if (templateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Template ${period.template_id} not found.`,
      });
    }

    const template = templateResult.rows[0];

    // 3) Load template entries for this template
    const entriesQuery = `
      SELECT
        id,
        template_id,
		division_id,
        department_id,
        staff_type_id,
        user_id,
        shift_type_id,
        day_of_week,
        week_of_cycle
      FROM shiftly_schema.shift_template_entries
      WHERE template_id = $1
    `;
    const entriesResult = await client.query(entriesQuery, [template.id]);
    const entries = entriesResult.rows;
	
	// 3b) Load staff shift rules once so we can snapshot staff_shift_rule_id + required_staff_snapshot
    const rulesResult = await client.query(`
      SELECT
        id,
        division_id,
        department_id,
        staff_type_id,
        shift_type_id,
        required_staff_count
      FROM shiftly_schema.staff_shift_rules
    `);
    const staffShiftRules = rulesResult.rows;



    // Remove existing TEMPLATE-based assignments for this period
    const deleteAssignmentsQuery = `
      DELETE FROM shiftly_schema.shift_assignments
      WHERE shift_period_id = $1
        AND source_type = 'TEMPLATE'
    `;
    await client.query(deleteAssignmentsQuery, [periodId]);

    // 4) Loop dates in the period and insert assignments
    const startDate = new Date(period.start_date);
    const endDate = new Date(period.end_date);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Invalid start_date or end_date in shift_period.',
      });
    }

    let current = new Date(startDate);
    let insertedCount = 0;

    while (current <= endDate) {
      const dayOfWeek = isoWeekday(current);
      const weekOfCycle = template.pattern_type === 'WEEKLY'
        ? 1
        : weekOfCycleForDate(current, template.cycle_length_weeks);

      const matchingEntries = entries.filter(
        (e) =>
          e.day_of_week === dayOfWeek &&
          (e.week_of_cycle === null || e.week_of_cycle === weekOfCycle),
      );

      for (const e of matchingEntries) {
        const shiftDateStr = formatYmd(current);
		
		       const matchedRule = findBestStaffShiftRule(staffShiftRules, {
          divisionId: e.division_id ?? null,
          departmentId: e.department_id,
          staffTypeId: e.staff_type_id,
          shiftTypeId: e.shift_type_id,
        });


        const insertAssignmentQuery = `
          INSERT INTO shiftly_schema.shift_assignments
          (
            shift_period_id,
            shift_date,
			division_id,
            department_id,
            user_id,
            staff_type_id,
            shift_type_id,
            source_type,
            status,
            status_comment,
			 staff_shift_rule_id,
            required_staff_snapshot,
            created_at,
            updated_at
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
			$7,
            'TEMPLATE',
            'GENERATED',
            NULL,
			$8,
			$9,
            NOW(),
            NOW()
          )
        `;

        const insertValues = [
          periodId,
          shiftDateStr,
		  e.division_id ?? null,
          e.department_id,
          e.user_id,
          e.staff_type_id,
          e.shift_type_id,
		  matchedRule ? matchedRule.id : null,
          matchedRule ? matchedRule.required_staff_count : null,
        ];

        await client.query(insertAssignmentQuery, insertValues);
        insertedCount += 1;
      }

      // advance one day
      current.setDate(current.getDate() + 1);
    }

    await client.query('COMMIT');

    return res.json({
      message: 'Assignments generated from template.',
      period_id: periodId,
      template_id: template.id,
      inserted_count: insertedCount,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Error during ROLLBACK:', rollbackErr);
      }
    }
       console.error('Error generating assignments from template:', err);
    return res.status(500).json({
      error: 'Database error',
      // typical PG error fields (if available)
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;