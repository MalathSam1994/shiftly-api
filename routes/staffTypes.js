// routes/staffTypes.js
const createCrudRouter = require('../createCrudRouter');
const { mapPostgresError } = require('../utils/postgresErrorMapper');

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
    case 'users':
      return 'users';
    case 'shift_assignments':
      return 'shift assignments';
    case 'shift_template_entries':
      return 'shift template entries';
    case 'staff_shift_rules':
      return 'staff shift rules';
    default:
      return tableName ? String(tableName).replace(/_/g, ' ') : 'another table';
  }
}

async function validateStaffTypeChange(pool, staffTypeId, action) {
  const validation = await pool.query(
    `SELECT shiftly_api.validate_staff_type_change($1, $2) AS result`,
    [staffTypeId, action],
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
      details: `Staff type cannot be ${actionLower}d because it is already linked.`,
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
      details: `Staff type cannot be ${actionLower}d because it is already linked.`,
      code: 'RECORD_IN_USE',
      validation_errors: {
        errors: [
          {
            code: 'STAFF_TYPE_LINKED',
            message: `Staff type cannot be ${actionLower}d because this staff type is already linked in ${linkedEntity}.`,
            linked_entity: linkedEntity,
          },
        ],
        warnings: [],
      },
      errors: [
          {
            code: 'STAFF_TYPE_LINKED',
            message: `Staff type cannot be ${actionLower}d because this staff type is already linked in ${linkedEntity}.`,
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

const staffTypesConfig = {
  table: 'shiftly_schema.staff_types',
  idColumn: 'id',
  columns: ['staff_type_name', 'is_active'],
  activeFilter: true,
  beforeUpdate: async (req, res, { pool }) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return false;
    }

    const validation = await validateStaffTypeChange(pool, id, 'UPDATE');
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

    const validation = await validateStaffTypeChange(pool, id, 'DELETE');
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

module.exports = createCrudRouter(staffTypesConfig);
