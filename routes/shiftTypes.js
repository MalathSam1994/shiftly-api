// routes/shiftTypes.js
const createCrudRouter = require('../createCrudRouter');

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

function formatLinkedEntity(tableName) {
  switch (tableName) {
    case 'shift_assignment_user_history':
      return 'shift assignment user history';
    case 'shift_assignments':
      return 'shift assignments';
    case 'shift_requests':
      return 'shift requests';
    case 'shift_template_entries':
      return 'shift template entries';
    case 'staff_shift_rules':
      return 'staff shift rules';
    default:
      return tableName ? String(tableName).replace(/_/g, ' ') : 'another table';
  }
}

async function validateShiftTypeChange(pool, shiftTypeId, action) {
  const validation = await pool.query(
    `SELECT shiftly_api.validate_shift_type_change($1, $2) AS result`,
    [shiftTypeId, action],
  );

  const validationResult = validation.rows?.[0]?.result;
  const ok =
    validationResult &&
    Object.prototype.hasOwnProperty.call(validationResult, 'ok')
      ? Boolean(validationResult.ok)
      : true;

  return {
    ok,
    result: validationResult,
  };
}

function buildValidationResponse(validationResult, action) {
  const actionLower = String(action || 'UPDATE').toLowerCase();
  return {
    http: 400,
    body: {
      error: 'Business rule violation',
      details: `Shift type cannot be ${actionLower}d because it is already linked.`,
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
    },
  };
}

function buildForeignKeyViolationResponse(err, action) {
  if (!err || err.code !== '23503') {
    return null;
  }

  const linkedEntity = formatLinkedEntity(err.table);
  const actionLower = String(action || 'UPDATE').toLowerCase();

  return {
    http: 400,
    body: {
      error: 'Business rule violation',
      details: `Shift type cannot be ${actionLower}d because it is already linked.`,
      code: 'P0001',
      validation_errors: {
        errors: [
          {
            code: 'SHIFT_TYPE_LINKED',
            message: `Shift type cannot be ${actionLower}d because this shift type is already linked in ${linkedEntity}.`,
            linked_table: err.table,
            linked_entity: linkedEntity,
            constraint: err.constraint,
          },
        ],
        warnings: [],
      },
      errors: [
        {
          code: 'SHIFT_TYPE_LINKED',
          message: `Shift type cannot be ${actionLower}d because this shift type is already linked in ${linkedEntity}.`,
          linked_table: err.table,
          linked_entity: linkedEntity,
          constraint: err.constraint,
        },
      ],
      warnings: [],
      db_detail: err.detail,
    },
  };
}

const shiftTypesConfig = {
  table: 'shiftly_schema.shift_types',
  idColumn: 'id',
  columns: [
    'shift_code',
    'shift_label',
    'start_time',
    'end_time',
    'duration_hours',
    'day_type',
    'notes',
  ],
   beforeUpdate: async (req, res, { pool }) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return false;
    }

    const validation = await validateShiftTypeChange(pool, id, 'UPDATE');
    if (!validation.ok) {
      const built = buildValidationResponse(validation.result, 'UPDATE');
      res.status(built.http).json(built.body);
      return false;
    }

    return true;
  },
  beforeDelete: async (req, res, { pool }) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return false;
    }

    const validation = await validateShiftTypeChange(pool, id, 'DELETE');
    if (!validation.ok) {
      const built = buildValidationResponse(validation.result, 'DELETE');
      res.status(built.http).json(built.body);
      return false;
    }

    return true;
  },
  mapDbError: (err, { action }) => {
    const fkMapped = buildForeignKeyViolationResponse(err, action);
    if (fkMapped) {
      return fkMapped;
    }

    const isBusiness = err && err.code === 'P0001';
    if (isBusiness) {
      return buildBusinessError(
        err,
        `Shift type cannot be ${String(action || 'UPDATE').toLowerCase()}d because it is already linked.`,
      );
    }

    return {
      http: 500,
      body: {
        error: 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      },
    };
  },
};

module.exports = createCrudRouter(shiftTypesConfig);
