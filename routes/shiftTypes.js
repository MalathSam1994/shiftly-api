// routes/shiftTypes.js
const createCrudRouter = require('../createCrudRouter');
const { mapPostgresError } = require('../utils/postgresErrorMapper');


 
const SHIFT_TYPE_BUSINESS_COLUMNS = [
  'shift_code',
  'shift_label',
  'start_time',
  'end_time',
  'duration_hours',
  'day_type',
  'notes',
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeTimeValue(value) {
  if (value == null) return null;

  const text = String(value).trim();
  if (!text) return '';

  const match = text.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/,
  );

  if (!match) {
    return text;
  }

  const hours = match[1].padStart(2, '0');
  const minutes = match[2];
  const seconds = match[3] || '00';

  return `${hours}:${minutes}:${seconds}`;
}

function shiftTypeValuesEqual(column, incomingValue, currentValue) {
  switch (column) {
    case 'duration_hours': {
      if (
        incomingValue == null ||
        String(incomingValue).trim() === ''
      ) {
        return currentValue == null;
      }

      return Number(incomingValue) === Number(currentValue);
    }

    case 'start_time':
    case 'end_time':
      return (
        normalizeTimeValue(incomingValue) ===
        normalizeTimeValue(currentValue)
      );

    case 'notes': {
      const incoming =
        incomingValue == null ? null : String(incomingValue);
      const current =
        currentValue == null ? null : String(currentValue);

      return incoming === current;
    }

    default:
      return String(incomingValue ?? '') === String(currentValue ?? '');
  }
}

function isOnlyShiftTypeStatusChange(body, currentRow) {
  if (!hasOwn(body, 'is_active')) {
    return false;
  }

  return SHIFT_TYPE_BUSINESS_COLUMNS.every((column) => {
    if (!hasOwn(body, column)) {
      return true;
    }

    return shiftTypeValuesEqual(
      column,
      body[column],
      currentRow[column],
    );
  });
}


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
    http: 409,
    body: {
      error: 'The record cannot be changed because it is referenced.',
      details: `Shift type cannot be ${actionLower}d because it is already linked.`,
      code: 'RECORD_IN_USE',
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
    http: 409,
    body: {
      error: 'The record cannot be changed because it is referenced.',
      details: `Shift type cannot be ${actionLower}d because it is already linked.`,
      code: 'RECORD_IN_USE',
      validation_errors: {
        errors: [
          {
            code: 'SHIFT_TYPE_LINKED',
            message: `Shift type cannot be ${actionLower}d because this shift type is already linked in ${linkedEntity}.`,
            linked_entity: linkedEntity,
          },
        ],
        warnings: [],
      },
      errors: [
          {
            code: 'SHIFT_TYPE_LINKED',
            message: `Shift type cannot be ${actionLower}d because this shift type is already linked in ${linkedEntity}.`,
            linked_entity: linkedEntity,
          },
        ],
      warnings: [],
    },
  };
}

function buildMappedError(err, action) {
  const mapped = mapPostgresError(err, { action });
  if (!mapped) return null;
  const { status, ...body } = mapped;
  return { http: status, body };
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
    'is_active',
  ],
  activeFilter: true,
   beforeUpdate: async (req, res, { pool }) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return false;
    }


    const currentResult = await pool.query(
      `
      SELECT
        shift_code,
        shift_label,
        start_time,
        end_time,
        duration_hours,
        day_type,
        notes,
        is_active
      FROM shiftly_schema.shift_types
      WHERE id = $1
      `,
      [id],
    );

    if (!currentResult.rows || currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return false;
    }

    // Activation/deactivation must remain possible even when the shift type
    // is referenced. Validation is still executed for every real data edit.
    if (isOnlyShiftTypeStatusChange(req.body, currentResult.rows[0])) {
      return true;
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
      return buildMappedError(err, action);
    }

    return null;
  },
};

module.exports = createCrudRouter(shiftTypesConfig);
