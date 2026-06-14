const createCrudRouter = require('../createCrudRouter');


const {
  enforceModuleLimit,
  isLicenseLimitError,
  buildLicenseLimitResponse,
} = require('../services/moduleLicense');
 
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
      details:
        (err && err.message)
          ? err.message
          : (fallbackMessage || 'Business rule violation.'),
      code: (err && err.code) ? err.code : 'P0001',
      routine: err && err.routine,
      validation_errors:
        (normalized.errors.length || normalized.warnings.length)
          ? normalized
          : undefined,
      errors: normalized.errors,
      warnings: normalized.warnings,
      db_detail: err && err.detail,
    },
  };
}


const divisionsConfig = {
  table: 'shiftly_schema.divisions',
  idColumn: 'id',
  columns: ['division_desc'],

  createHandler: async (req, res, { pool, config, allColumns }) => {
    const divisionDesc =
      typeof req.body?.division_desc === 'string'
        ? req.body.division_desc.trim()
        : req.body?.division_desc;

    if (typeof divisionDesc !== 'string' || !divisionDesc) {
      return res.status(400).json({
        error: 'division_desc is required.',
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '20000ms'`);

      // Backend-only module license validation.
      // Example:
      // SHIFTLY_LICENSE_MAX_DIVISIONS=3
      // If 3 divisions already exist, creating the 4th one is blocked here.
      await enforceModuleLimit(client, 'divisions');

      const result = await client.query(
        `
        INSERT INTO ${config.table} (division_desc)
        VALUES ($1)
        RETURNING ${allColumns.join(', ')}
        `,
        [divisionDesc],
      );

      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      if (isLicenseLimitError(err)) {
        console.warn('Division license limit reached:', {
          currentCount: err.currentCount,
          maxAllowed: err.maxAllowed,
        });

        const built = buildLicenseLimitResponse(err);
        return res.status(built.http).json(built.body);
      }

      console.error('Error inserting division:', err);
      return res.status(500).json({
        error: 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    } finally {
      client.release();
    }
  },

  deleteHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const validation = await pool.query(
        `SELECT shiftly_api.validate_division_delete($1) AS result`,
        [id],
      );

      const validationResult = validation.rows?.[0]?.result;
      const ok =
        validationResult &&
        Object.prototype.hasOwnProperty.call(validationResult, 'ok')
          ? Boolean(validationResult.ok)
          : true;

      if (!ok) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: 'Division cannot be deleted because it is already linked.',
          code: 'P0001',
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
      console.error('Error deleting division:', err);

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        const built = buildBusinessError(
          err,
          'Division cannot be deleted because it is already linked.',
        );
        return res.status(built.http).json(built.body);
      }

      return res.status(500).json({
        error: 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    }
  },
};

module.exports = createCrudRouter(divisionsConfig);
