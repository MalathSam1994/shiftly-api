// routes/shiftPeriods.js
const express = require('express');
const pool = require('../db');
const createCrudRouter = require('../createCrudRouter');



// Parse a date input into a Date (UTC midnight) if possible.
// Accepts ISO strings like "2026-02-14" or "2026-02-14T00:00:00.000Z",
// and also accepts Date objects.
function toUtcMidnightDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const s = String(value).trim();
  if (!s) return null;
  const datePart = s.split('T')[0];
  const d = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function utcTodayMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseRequiredInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function buildPeriodSelect(tableName = 'shiftly_schema.shift_periods') {
  return `
    SELECT
      sp.id,
      sp.period_type,
      to_char(sp.start_date, 'YYYY-MM-DD') AS start_date,
      to_char(sp.end_date, 'YYYY-MM-DD') AS end_date,
      sp.division_id,
      sp.department_id,
      COALESCE(dd.division_desc, dv.division_desc) AS division_desc,
      COALESCE(dd.department_desc, dep.department_desc) AS department_desc,
      sp.template_id,
      sp.generated_at,
      sp.generated_by_user_id,
      sp.status,
      sp.description
    FROM ${tableName} sp
    LEFT JOIN shiftly_schema.division_departments dd
      ON dd.division_id = sp.division_id
     AND dd.department_id = sp.department_id
    LEFT JOIN shiftly_schema.divisions dv ON dv.id = sp.division_id
    LEFT JOIN shiftly_schema.departments dep ON dep.id = sp.department_id
  `;
}

async function validatePeriodOrgAndRange(pool, payload, options = {}) {
  const periodId = options.periodId ?? null;
  const current = options.current ?? {};
  const merged = { ...current, ...payload };

  const divisionId = parseRequiredInt(merged.division_id);
  const departmentId = parseRequiredInt(merged.department_id);
  const periodType = String(merged.period_type || '').trim().toUpperCase();
  const startDate = merged.start_date;
  const endDate = merged.end_date;

  if (divisionId == null || departmentId == null) {
    return 'Division and Department are required for Shift Periods.';
  }

  if (!periodType) {
    return 'period_type is required.';
  }

  const start = toUtcMidnightDate(startDate);
  const end = toUtcMidnightDate(endDate);

  if (start == null || end == null) {
    return 'Invalid start_date or end_date. Expected ISO dates like YYYY-MM-DD.';
  }

  if (end < start) {
    return 'End date must be on/after start date.';
  }

  const mapping = await pool.query(
    `
    SELECT 1
    FROM shiftly_schema.division_departments
    WHERE division_id = $1
      AND department_id = $2
    LIMIT 1
    `,
    [divisionId, departmentId],
  );

  if (!mapping.rows.length) {
    return 'Selected Department does not belong to the selected Division.';
  }

  const duplicate = await pool.query(
    `
    SELECT id
    FROM shiftly_schema.shift_periods
    WHERE period_type = 'MONTHLY'
      AND $1 = 'MONTHLY'
      AND start_month = make_date(EXTRACT(year FROM $2::date)::int, EXTRACT(month FROM $2::date)::int, 1)
      AND division_id = $3
      AND department_id = $4
      AND ($5::int IS NULL OR id <> $5::int)
    LIMIT 1
    `,
    [periodType, startDate, divisionId, departmentId, periodId],
  );

  if (duplicate.rows.length) {
    return 'A Shift Period already exists for this month, division, and department.';
  }

  const overlap = await pool.query(
    `
    SELECT id
    FROM shiftly_schema.shift_periods
    WHERE division_id = $1
      AND department_id = $2
      AND daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
      AND ($5::int IS NULL OR id <> $5::int)
    LIMIT 1
    `,
    [divisionId, departmentId, startDate, endDate, periodId],
  );

  if (overlap.rows.length) {
    return 'A Shift Period already overlaps this date range for the selected division and department.';
  }

  return null;
}


const shiftPeriodsConfig = {
  table: 'shiftly_schema.shift_periods',
  idColumn: 'id',
  columns: [
    'period_type',
    'start_date',
    'end_date',
    'division_id',
    'department_id',
    'template_id',
    'generated_at',
    'generated_by_user_id',
    'status',
    'description',
  ],

    // ✅ Always list periods newest first.
  // ✅ Return DATE columns as pure YYYY-MM-DD strings to avoid JS/Flutter timezone shifts
  //    like DB 2026-05-01 appearing in UI as 30/04/2026.
  listHandler: async (req, res, { pool, config }) => {
    try {
      const result = await pool.query(`
        ${buildPeriodSelect(config.table)}
        ORDER BY sp.start_date DESC, sp.division_id ASC, sp.department_id ASC, sp.id DESC
      `);

      return res.json(result.rows);
    } catch (err) {
      console.error('Error listing shift periods:', err);
      return res.status(500).json({
        error: 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    }
  },



    // Override CREATE so we can map constraint/unique errors into friendly JSON
  createHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const body = req.body || {};


      // ✅ Business validation: do not allow creating periods with dates in the past.
      // Rule:
      // - start_date must be >= today
      // - end_date must be >= today
      //
      // Notes:
      // - We compare by DATE (not time) using UTC midnight to avoid timezone surprises.
      // - This validation is best enforced server-side even if UI also blocks it.
      const today = utcTodayMidnight();
      const start = toUtcMidnightDate(body.start_date);
      const end = toUtcMidnightDate(body.end_date);

      // If either date is present but invalid, return a clean 400.
      if (body.start_date !== undefined && start == null) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: 'Invalid start_date. Expected an ISO date like YYYY-MM-DD.',
          code: 'P0001',
        });
      }
      if (body.end_date !== undefined && end == null) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: 'Invalid end_date. Expected an ISO date like YYYY-MM-DD.',
          code: 'P0001',
        });
      }

      // Only validate when dates are provided (they should be for CREATE).
      if (start != null && start < today) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: 'Start date cannot be in the past.',
          code: 'P0001',
        });
      }
      if (end != null && end < today) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: 'End date cannot be in the past.',
          code: 'P0001',
        });
      }

      const validationError = await validatePeriodOrgAndRange(pool, body);
      if (validationError) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: validationError,
          code: 'P0001',
        });
      }

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
        RETURNING id
      `;

      const result = await pool.query(sql, values);
      const selected = await pool.query(
        `
        ${buildPeriodSelect(config.table)}
        WHERE sp.id = $1
        `,
        [result.rows[0].id],
      );
      return res.status(201).json(selected.rows[0]);
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

  updateHandler: async (req, res, { pool, config }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const currentResult = await pool.query(
        `
        SELECT
          id,
          period_type,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          division_id,
          department_id,
          template_id,
          generated_at,
          generated_by_user_id,
          status,
          description
        FROM ${config.table}
        WHERE id = $1
        `,
        [id],
      );

      if (!currentResult.rows.length) {
        return res.status(404).json({ error: 'Not found' });
      }

      const body = req.body || {};
      const validationError = await validatePeriodOrgAndRange(pool, body, {
        periodId: id,
        current: currentResult.rows[0],
      });
      if (validationError) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: validationError,
          code: 'P0001',
        });
      }

      const cols = config.columns.filter((c) => body[c] !== undefined);
      if (!cols.length) {
        return res.status(400).json({
          error: 'Invalid payload',
          details: 'No valid columns were provided.',
          code: 'P0001',
        });
      }

      const sets = cols.map((c, i) => `${c} = $${i + 1}`);
      const values = cols.map((c) => body[c]);
      values.push(id);

      await pool.query(
        `
        UPDATE ${config.table}
        SET ${sets.join(', ')}
        WHERE id = $${values.length}
        `,
        values,
      );

      const result = await pool.query(
        `
        ${buildPeriodSelect(config.table)}
        WHERE sp.id = $1
        `,
        [id],
      );

      return res.json(result.rows[0]);
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
        RETURNING
          id,
          period_type,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          division_id,
          department_id,
          template_id,
          generated_at,
          generated_by_user_id,
          status,
          description
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
  if (err && (err.code === '23505' || err.code === '23P01')) {
     const periodType = (payload && payload.period_type
      ? String(payload.period_type)
      : '').toUpperCase();

    const friendly =
      err.code === '23P01'
        ? 'A Shift Period already overlaps this date range for the selected division and department.'
        : periodType === 'MONTHLY'
        ? 'A Shift Period already exists for this month, division, and department.'
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

 
// Try to parse Postgres error DETAIL (often JSON text when raised from PL/pgSQL)
function tryParseJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  // Accept JSON objects/arrays only
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

// Normalize ANY "validation_errors" payload into the shape:
//   { errors: [...], warnings: [...] }
// Supported inputs:
// - { errors: [...], warnings: [...] }
// - { validation_errors: { errors: [...], warnings: [...] } }
// - { validation_errors: [...] }  -> treated as errors
// - [ ... ]                       -> treated as errors
function normalizeValidationErrors(anyVal) {
  let v = anyVal;
  if (v && typeof v === 'object' && !Array.isArray(v) && v.validation_errors !== undefined) {
    v = v.validation_errors;
  }

  if (Array.isArray(v)) {
    return { errors: v, warnings: [] };
  }

  if (v && typeof v === 'object') {
    const errors = Array.isArray(v.errors) ? v.errors : [];
    const warnings = Array.isArray(v.warnings) ? v.warnings : [];
    // Some earlier versions may have used "validation_errors" as a list inside an object:
    // { validation_errors: [...] } already handled above, but keep this for safety.
    if (!errors.length && !warnings.length && Array.isArray(v.validation_errors)) {
      return { errors: v.validation_errors, warnings: [] };
    }
    return { errors, warnings };
  }

  return { errors: [], warnings: [] };
}


// Build consistent JSON error responses for "business" exceptions (ERRCODE P0001)
function buildBusinessError(err, fallbackMessage) {
  const parsedDetail = tryParseJson(err && err.detail);
  const normalized = normalizeValidationErrors(parsedDetail);

  return {
    http: 400,
    body: {
      error: 'Business rule violation',
      details: (err && err.message) ? err.message : (fallbackMessage || 'Business rule violation.'),
      code: (err && err.code) ? err.code : 'P0001',
      routine: err && err.routine,
      // IMPORTANT:
      // If the DB raised DETAIL as JSON (e.g. validation errors array),
      // expose it as structured data so the UI can show real details.
      // ✅ Always return { errors: [], warnings: [] } when any validation exists.
     validation_errors:
       (normalized.errors.length || normalized.warnings.length)
         ? normalized
         : undefined,
      // Keep the raw detail too (helps troubleshooting when JSON parsing fails)
      db_detail: err && err.detail,
    },
  };
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

    // ✅ DEBUG PATH:
  // Call: POST /shift-periods/:id/approve?__debug_validation=1
  // This returns a deterministic payload containing BOTH warnings + errors
  // so you can verify whether the issue is in:
  // - Dart parsing (CoverageValidationException)
  // - SnackBar display/queueing
  // - endpoint mapping
  if (String(req.query.__debug_validation || '') === '1') {
    const errors = [
      {
        code: 'GAP_DETECTED',
        message:
          'DEBUG ERROR: St Johns Park care / Radiology: Missing coverage 2026-03-29 22:00 → 2026-03-30 10:00 (12:00:00) between assignment 791 and assignment 796.',
        division_name: 'St Johns Park care',
        department_name: 'Radiology',
      },
    ];
    const warnings = [
      {
        code: 'OVERLAP_DETECTED',
        message:
          'DEBUG WARNING: St Johns Park care / Radiology: Overlap 2026-03-10 06:00 → 2026-03-10 08:00 (02:00:00) between assignment 555 and assignment 556.',
        division_name: 'St Johns Park care',
        department_name: 'Radiology',
      },
    ];

    return res.status(400).json({
      error: 'Business rule violation',
      details: 'DEBUG: synthetic coverage validation payload (warnings + errors).',
      code: 'P0001',
      validation_errors: { errors, warnings },
      // keep top-level too (Flutter parser supports both)
      errors,
      warnings,
    });
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
     if (isBusiness) {
       const built = buildBusinessError(
         err,
         `Coverage validation failed for period (${periodId}).`,
       );


      // Also ensure top-level "errors"/"warnings" exist for maximum compatibility,
      // while keeping validation_errors for structured parsing.
      const ve = normalizeValidationErrors(built.body.validation_errors);
      built.body.errors = ve.errors;
      built.body.warnings = ve.warnings;       
       return res.status(built.http).json(built.body);
     }

     return res.status(500).json({
       error: 'Database error',
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



// Optional: Validate coverage without approving (for UI pre-check)
router.get('/:id/validate-approval', async (req, res) => {
  const periodId = parseInt(req.params.id, 10);
  if (Number.isNaN(periodId)) {
    return res.status(400).json({ error: 'Invalid period id.' });
  }
  try {
    const result = await pool.query(
      `SELECT shiftly_api.validate_period_coverage($1) AS result`,
      [periodId],
    );
    return res.json(result.rows[0].result);
  } catch (err) {
    console.error('Error validating period coverage:', err);
    const isBusiness = err && err.code === 'P0001';
    if (isBusiness) {
      const built = buildBusinessError(err, 'Coverage validation failed.');
      return res.status(built.http).json(built.body);
    }
    return res.status(500).json({
      error: 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

module.exports = router;


