const createCrudRouter = require('../createCrudRouter');
const {
  activeStatusSql,
  parseActiveStatusQuery,
  parseOptionalBoolean,
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



// Code table: shiftly_schema.absence_types
const absenceTypesConfig = {
  table: 'shiftly_schema.absence_types',
  idColumn: 'code',
  columns: ['description', 'is_active', 'sort_order'],
  // Optional: keep list stable for UI
  listHandler: async (req, res, ctx) => {
    try {
      const { config } = ctx;
      const active = activeStatusSql(parseActiveStatusQuery(req.query), 'is_active', 1);
      const where = active.clause ? `WHERE ${active.clause}` : '';
      const q = `
        SELECT code, description, is_active, sort_order, created_at, updated_at
          FROM ${config.table}
        ${where}
         ORDER BY is_active DESC, sort_order ASC, code ASC
      `;
      const result = await ctx.pool.query(q, active.params);
      res.json(result.rows);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      throw err;
    }
  },
  deleteHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const code = String(req.params.id ?? '').trim().toUpperCase();
      if (!code) {
        return res.status(400).json({ error: 'Invalid code.' });
      }

      const validation = await pool.query(
        `SELECT shiftly_api.validate_absence_type_delete($1) AS result`,
        [code],
      );

      const validationResult = validation.rows?.[0]?.result;
      const ok =
        validationResult &&
        Object.prototype.hasOwnProperty.call(validationResult, 'ok')
          ? Boolean(validationResult.ok)
          : true;

      if (!ok) {
        return sendApiError(req, res, {
          status: 409,
          error: 'The record cannot be deleted because it is referenced.',
          code: 'RECORD_IN_USE',
          details: 'Absence type cannot be deleted because it is already linked.',
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
        [code],
      );

      if (!result.rows || result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.json({ deleted: result.rows[0] });
    } catch (err) {
      console.error('Error deleting absence type:', err);

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        return sendPostgresError(req, res, err, {
          action: 'DELETE',
          label: 'Error deleting absence type',
        });
      }

      return sendPostgresError(req, res, err, {
        action: 'DELETE',
        label: 'Error deleting absence type',
      });
    }
  },
  updateHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const oldCode = String(req.params.id ?? '').trim().toUpperCase();
      if (!oldCode) {
        return res.status(400).json({ error: 'Invalid code.' });
      }

      const validation = await pool.query(
        `SELECT shiftly_api.validate_absence_type_change($1, $2, $3) AS result`,
        [oldCode, req.body.description, 'UPDATE'],
      );

      const validationResult = validation.rows?.[0]?.result;
      const ok =
        validationResult &&
        Object.prototype.hasOwnProperty.call(validationResult, 'ok')
          ? Boolean(validationResult.ok)
          : true;

      if (!ok) {
        return sendApiError(req, res, {
          status: 409,
          error: 'The record cannot be changed because it is referenced.',
          code: 'RECORD_IN_USE',
          details:
            'Absence type cannot be updated because the derived code change would affect linked data.',
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

      const sets = [];
      const values = [];
      let i = 1;

      for (const col of config.columns) {
        if (Object.prototype.hasOwnProperty.call(req.body, col)) {
          sets.push(`${col} = $${i}`);
          values.push(
            col === 'is_active'
              ? parseOptionalBoolean(req.body[col], 'is_active')
              : req.body[col],
          );
          i++;
        }
      }

      if (sets.length === 0) {
        return res
          .status(400)
          .json({ error: 'No valid columns provided for update' });
      }

      values.push(oldCode);
      const query = `
        UPDATE ${config.table}
        SET ${sets.join(', ')}
        WHERE ${config.idColumn} = $${i}
        RETURNING ${allColumns.join(', ')}
      `;

      const result = await pool.query(query, values);

      if (!result.rows || result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      console.error('Error updating absence type:', err);

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        return sendPostgresError(req, res, err, {
          action: 'UPDATE',
          label: 'Error updating absence type',
        });
      }

      return sendPostgresError(req, res, err, {
        action: 'UPDATE',
        label: 'Error updating absence type',
      });
    }
  },

};

module.exports = createCrudRouter(absenceTypesConfig);
