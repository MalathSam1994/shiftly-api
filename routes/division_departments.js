const createCrudRouter = require('../createCrudRouter');
const {
  parseCreateIsActive,
  sendActiveStatusError,
} = require('../utils/activeStatus');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

function tryParseJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function normalizeValidationErrors(anyVal) {
  let v = anyVal;

  if (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    v.validation_errors !== undefined
  ) {
    v = v.validation_errors;
  }

  if (Array.isArray(v)) {
    return { errors: v, warnings: [] };
  }

  if (v && typeof v === 'object') {
    const errors = Array.isArray(v.errors) ? v.errors : [];
    const warnings = Array.isArray(v.warnings) ? v.warnings : [];

    if (!errors.length && !warnings.length && Array.isArray(v.validation_errors)) {
      return { errors: v.validation_errors, warnings: [] };
    }

    return { errors, warnings };
  }

  return { errors: [], warnings: [] };
}

function buildBusinessError(err, fallbackMessage) {
  const parsedDetail = tryParseJson(err && err.detail);
  const normalized = normalizeValidationErrors(parsedDetail);

  return {
    http: 400,
    body: {
      error: 'Business rule violation',
      details: fallbackMessage || 'Business rule violation.',
      code: 'BUSINESS_RULE_VIOLATION',
      validation_errors:
        (normalized.errors.length || normalized.warnings.length)
          ? normalized
          : undefined,
      errors: normalized.errors,
      warnings: normalized.warnings,
    },
  };
}


const divisionDepartmentsConfig = {
  table: 'shiftly_schema.division_departments',
  idColumn: 'id',
  columns: ['division_id', 'department_id', 'division_desc', 'department_desc', 'is_active'],
  activeFilter: true,
  createHandler: async (req, res, { pool, config, allColumns }) => {
    const divisionId = parseInt(req.body.division_id, 10);
    const departmentId = parseInt(req.body.department_id, 10);
    const isActive = parseCreateIsActive({ is_active: req.body.is_active });

    if (Number.isNaN(divisionId) || Number.isNaN(departmentId)) {
      return res.status(400).json({
        error: 'Invalid payload.',
        details: 'division_id and department_id are required integers.',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingResult = await client.query(
        `
        SELECT ${allColumns.join(', ')}
        FROM ${config.table}
        WHERE department_id = $1
        LIMIT 1
        `,
        [departmentId],
      );

      const existing = existingResult.rows?.[0];

      // Already assigned to the same division -> no-op
      if (existing && Number(existing.division_id) === divisionId) {
        await client.query('COMMIT');
        return res.status(200).json(existing);
      }

      // Real move from another division -> validate first
      if (existing && Number(existing.division_id) !== divisionId) {
        const validation = await client.query(
          `SELECT shiftly_api.validate_department_move($1, $2) AS result`,
          [departmentId, divisionId],
        );

        const validationResult = validation.rows?.[0]?.result;
        const ok =
          validationResult &&
          Object.prototype.hasOwnProperty.call(validationResult, 'ok')
            ? Boolean(validationResult.ok)
            : true;

        if (!ok) {
          await client.query('ROLLBACK');
          return sendApiError(req, res, {
            status: 409,
            error: 'The record cannot be changed because it is referenced.',
            code: 'RECORD_IN_USE',
            details:
              'Department cannot be moved because it is already linked.',
            validation_errors: {
              errors: Array.isArray(validationResult?.errors)
                ? validationResult.errors
                : [],
              warnings: Array.isArray(validationResult?.warnings)
                ? validationResult.warnings
                : [],
            },
            errors: Array.isArray(validationResult?.errors)
              ? validationResult.errors
              : [],
            warnings: Array.isArray(validationResult?.warnings)
              ? validationResult.warnings
              : [],
          });
        }

        await client.query(
          `
          DELETE FROM ${config.table}
          WHERE id = $1
          `,
          [existing.id],
        );
      }

      const insertResult = await client.query(
        `
        INSERT INTO ${config.table} (
          division_id,
          department_id,
          is_active
        )
        SELECT
          d.id,
          dep.id,
          $3
        FROM shiftly_schema.divisions d
        JOIN shiftly_schema.departments dep ON dep.id = $2
        WHERE d.id = $1
        RETURNING ${allColumns.join(', ')}
        `,
        [divisionId, departmentId, isActive],
      );

      if (!insertResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Invalid payload.',
          details: 'Selected division or department does not exist.',
        });
      }

      await client.query('COMMIT');
      return res.status(201).json(insertResult.rows[0]);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      console.error('Error creating/moving division department:', err);
      if (sendActiveStatusError(res, err)) return;

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        return sendPostgresError(req, res, err, {
          action: 'CREATE',
          label: 'Error creating/moving division department',
        });
      }

      return sendPostgresError(req, res, err, {
        action: 'CREATE',
        label: 'Error creating/moving division department',
      });
    } finally {
      client.release();
    }
  },
};

module.exports = createCrudRouter(divisionDepartmentsConfig);
