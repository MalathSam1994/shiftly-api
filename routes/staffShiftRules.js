// routes/staffShiftRules.js
const createCrudRouter = require('../createCrudRouter');
const {
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

async function runRuleValidation(pool, ruleId, actionLabel) {
  const validation = await pool.query(
    `SELECT shiftly_api.validate_staff_shift_rule_change($1, $2) AS result`,
    [ruleId, actionLabel],
  );

  const validationResult = validation.rows?.[0]?.result;
  const ok =
    validationResult &&
    Object.prototype.hasOwnProperty.call(validationResult, 'ok')
      ? Boolean(validationResult.ok)
      : true;

  return {
    ok,
    validationResult,
  };
}

const staffShiftRulesConfig = {
  table: 'shiftly_schema.staff_shift_rules',
  idColumn: 'id',
  columns: [
    'division_id',
    'department_id',
    'staff_type_id',
    'shift_type_id',
    'required_staff_count',
    'is_active',
  ],
  activeFilter: true,
  updateHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const { ok, validationResult } = await runRuleValidation(
        pool,
        id,
        'UPDATE',
      );

      if (!ok) {
        return sendApiError(req, res, {
          status: 409,
          error: 'The record cannot be changed because it is referenced.',
          code: 'RECORD_IN_USE',
          details:
            'Staff shift rule cannot be updated because it is already linked.',
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

      values.push(id);
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
      console.error('Error updating staff shift rule:', err);

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        return sendPostgresError(req, res, err, {
          action: 'UPDATE',
          label: 'Error updating staff shift rule',
        });
      }

      return sendPostgresError(req, res, err, {
        action: 'UPDATE',
        label: 'Error updating staff shift rule',
      });
    }
  },
  deleteHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const { ok, validationResult } = await runRuleValidation(
        pool,
        id,
        'DELETE',
      );

      if (!ok) {
        return sendApiError(req, res, {
          status: 409,
          error: 'The record cannot be deleted because it is referenced.',
          code: 'RECORD_IN_USE',
          details:
            'Staff shift rule cannot be deleted because it is already linked.',
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
      console.error('Error deleting staff shift rule:', err);

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        return sendPostgresError(req, res, err, {
          action: 'DELETE',
          label: 'Error deleting staff shift rule',
        });
      }

      return sendPostgresError(req, res, err, {
        action: 'DELETE',
        label: 'Error deleting staff shift rule',
      });
    }
  },
};

module.exports = createCrudRouter(staffShiftRulesConfig);
