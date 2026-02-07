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

    // Override CREATE so we can map constraint/unique errors into friendly JSON
  createHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const body = req.body || {};

      // Only allow configured columns that were provided
      const cols = config.columns.filter((c) => body[c] !== undefined);
      if (!cols.length) {
        return res.status(400).json({
          error: 'Invalid payload',
          details: 'No valid columns were provided.',
          code: 'P0001',
        });
      }

      const values = cols.map((c) => body[c]);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      const sql = `
        INSERT INTO ${config.table} (${cols.join(', ')})
        VALUES (${placeholders})
        RETURNING ${allColumns.join(', ')}
      `;

      const result = await pool.query(sql, values);
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      const mapped = mapShiftPeriodsDbError(err, req.body);
      if (mapped) {
        return res.status(mapped.http).json(mapped.body);
      }
      const isBusiness = err && err.code === 'P0001';
      return res.status(isBusiness ? 400 : 500).json({
        error: isBusiness ? 'Business rule violation' : 'Database error',
        details: err.message,
        code: err.code,
        constraint: err.constraint,
        routine: err.routine,
      });
    }
  },


  // Prevent deleting APPROVED periods (locked)
  deleteHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const meta = await pool.query(
        `SELECT status FROM ${config.table} WHERE ${config.idColumn} = $1`,
        [id],
      );
      if (!meta.rows || meta.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      const status = (meta.rows[0].status || '').toString().trim();
      if (status === 'APPROVED') {
        return res.status(400).json({
          error: 'Business rule violation',
          details: 'Cannot delete an APPROVED period.',
          code: 'P0001',
        });
      }

      const result = await pool.query(
        `
        DELETE FROM ${config.table}
        WHERE ${config.idColumn} = $1
        RETURNING ${allColumns.join(', ')}
        `,
        [id],
      );
      if (!result.rows || result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }
      return res.json({ deleted: result.rows[0] });
    } catch (err) {
      console.error('Error deleting period:', err);
      const isBusiness = err && err.code === 'P0001';
      return res.status(isBusiness ? 400 : 500).json({
        error: isBusiness ? 'Business rule violation' : 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    }
  },

};
const router = createCrudRouter(shiftPeriodsConfig);



// Optional: a small helper to convert common DB constraint errors into clearer messages.
function mapShiftPeriodsDbError(err, payload) {
  // Postgres UNIQUE VIOLATION
  if (err && err.code === '23505') {
     const periodType = (payload && payload.period_type
      ? String(payload.period_type)
      : '').toUpperCase();

    const friendly =
      periodType === 'MONTHLY'
        ? 'A MONTHLY period already exists for this month. Only one monthly period per month is allowed.'
        : 'A shift period with the same key already exists.';

    return {
      http: 400,
      body: {
        error: 'Business rule violation',
        details: friendly,
        code: err.code,
        constraint: err.constraint,
        // keep the technical hint for troubleshooting without exposing a full stack
        db_detail: err.detail,
      },
    };
  }

  // Postgres CHECK VIOLATION
  if (err && err.code === '23514') {
    const msg = (err.constraint || err.message || '').toString();
    return {
      http: 400,
      body: {
        error: 'Business rule violation',
        details:
          msg.includes('shift_periods_monthly_dates_check')
            ? 'For MONTHLY periods: start_date must be the 1st day of the month, and end_date must be the last day of the same month.'
            : 'A validation rule was violated while creating/updating the period.',
        code: err.code,
        constraint: err.constraint,
        db_detail: err.detail,
      },
    };
  }

  return null;
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

 try {
 const result = await pool.query(
 `SELECT shiftly_api.generate_assignments_from_template($1) AS result`,
 [periodId],
 );
 return res.json(result.rows[0].result);
 } catch (err) {
      console.error('Error generating assignments from template:', err);
    // Stored function throws a controlled exception (ERRCODE P0001) for known business errors.
    const isBusiness = err && err.code === 'P0001';
    return res.status(isBusiness ? 400 : 500).json({
      error: isBusiness ? 'Business rule violation' : 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

/**
 * POST /shift-periods/:id/approve
 *
 * ✅ One backend call, one DB transaction, TWO SQL UPDATE statements:
 *  1) Update all non-cancelled assignments to APPROVED
 *  2) Update the period itself to APPROVED
 *
 * This fixes "nothing happens" UX (no multi-request loops from Flutter).
 */
router.post('/:id/approve', async (req, res) => {
  const periodId = parseInt(req.params.id, 10);

  if (Number.isNaN(periodId)) {
    return res.status(400).json({ error: 'Invalid period id.' });
  }

   try {
 const result = await pool.query(
 `SELECT shiftly_api.approve_period_with_assignments($1) AS result`,
 [periodId],
 );
 return res.json(result.rows[0].result);
 } catch (err) {
 
    console.error('Error approving period:', err);
     const isBusiness = err && err.code === 'P0001';
   return res.status(isBusiness ? 400 : 500).json({
     error: isBusiness ? 'Business rule violation' : 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });

  }
});


// If your createCrudRouter exposes POST /shift-periods, it likely has its own try/catch.
// If you want the above friendly mapping for CREATE/UPDATE too, the best place is inside createCrudRouter’s error handler.
// If you can't touch it, you can wrap the router-level error middleware here:
router.use((err, req, res, next) => {
  const mapped = mapShiftPeriodsDbError(err);
  if (mapped) {
    return res.status(mapped.http).json(mapped.body);
  }
  return next(err);
});


module.exports = router;