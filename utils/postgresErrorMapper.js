const { sendApiError, sendInternalError } = require('./apiError');

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripUnsafeDbTokens(message) {
  return oneLine(message)
    .replace(/\((?:uq|fk|pk|ck|ex)_[^)]+\)/gi, '')
    .replace(/\b(?:uq|fk|pk|ck|ex)_[a-z0-9_]+\b/gi, '')
    .replace(/\bshiftly_(?:schema|api)\.[a-z0-9_]+\b/gi, '')
    .replace(/\b(?:schema|table|constraint|routine|where)=\S+/gi, '')
    .replace(/\b(?:user_id|assignmentId|period_id|shift_type_id)=\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function safeValidationPayload(err) {
  const parsedDetail = parseJsonMaybe(err && err.detail);
  const parsedMessage = parseJsonMaybe(err && err.message);
  const payload = parsedDetail || parsedMessage;
  if (!payload || typeof payload !== 'object') return null;

  const validation = payload.validation_errors || payload;
  const errors = Array.isArray(validation.errors)
    ? validation.errors
    : Array.isArray(payload.errors)
      ? payload.errors
      : [];
  const warnings = Array.isArray(validation.warnings)
    ? validation.warnings
    : Array.isArray(payload.warnings)
      ? payload.warnings
      : [];

  if (!errors.length && !warnings.length) return null;
  return {
    errors,
    warnings,
    validation_errors: payload.validation_errors || {
      errors,
      warnings,
    },
  };
}

function classifyMessage(message) {
  const normalized = oneLine(message);
  const lower = normalized.toLowerCase();

  if (!normalized) return null;

  if (lower.includes('primary manager')) {
    return {
      code: 'PRIMARY_MANAGER_REQUIRED',
      status: 422,
      details:
        'A primary manager must be assigned before this workflow request can be submitted.',
    };
  }

  if (lower.includes('overlap') || lower.includes('overlapping')) {
    return {
      code: 'SHIFT_PERIOD_OVERLAP',
      status: 409,
      details: stripUnsafeDbTokens(normalized) || 'The shift period overlaps another period.',
    };
  }

  if (lower.includes('department') && lower.includes('division')) {
    return {
      code: 'DEPARTMENT_DIVISION_MISMATCH',
      status: 422,
      details:
        'The selected department does not belong to the selected division.',
    };
  }

  if (lower.includes('not the current approver')) {
    return {
      code: 'NOT_CURRENT_APPROVER',
      status: 403,
      details: 'You are not the current approver for this request.',
    };
  }

  if (lower.includes('duplicate') || lower.includes('already has an assignment')) {
    return {
      code: 'DUPLICATE_SHIFT_ASSIGNMENT',
      status: 409,
      details: 'The user already has an assignment for this shift slot.',
    };
  }

  if (lower.includes('already has an absence')) {
    return {
      code: 'DUPLICATE_ABSENCE',
      status: 409,
      details: 'The user already has an absence covering this date.',
    };
  }

  if (lower.includes('inactive') && lower.includes('reference')) {
    return {
      code: 'INACTIVE_REFERENCE',
      status: 422,
      details: 'The selected record is inactive and cannot be used.',
    };
  }

  if (lower.includes('cannot be deleted') || lower.includes('already linked')) {
    return {
      code: 'RECORD_IN_USE',
      status: 409,
      details: stripUnsafeDbTokens(normalized) ||
        'The record cannot be deleted because it is referenced.',
    };
  }

  if (lower.includes('not found')) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      status: 404,
      details: 'The requested record could not be found.',
    };
  }

  if (
    lower.startsWith('cannot ') ||
    lower.startsWith('invalid ') ||
    lower.startsWith('missing ') ||
    lower.startsWith('only ') ||
    lower.startsWith('you cannot ') ||
    lower.startsWith('you can only ') ||
    lower.includes(' is required') ||
    lower.includes(' cannot be ')
  ) {
    return {
      code: 'INVALID_OPERATION',
      status: 422,
      details: stripUnsafeDbTokens(normalized),
    };
  }

  return null;
}

function mapConstraint(err) {
  const constraint = String(err && err.constraint || '').toLowerCase();

  if (constraint.includes('overlap')) {
    return {
      status: 409,
      code: 'SHIFT_PERIOD_OVERLAP',
      error: 'The shift period overlaps another period.',
      details: 'Choose dates that do not overlap an existing shift period.',
    };
  }

  if (constraint.includes('assignment')) {
    return {
      status: 409,
      code: 'DUPLICATE_SHIFT_ASSIGNMENT',
      error: 'The user already has an assignment for this shift slot.',
    };
  }

  return null;
}

function mapPostgresError(err, context = {}) {
  const pgCode = String(err && err.code || '');
  const validation = safeValidationPayload(err);
  if (validation) {
    return {
      status: 422,
      code: 'VALIDATION_FAILED',
      error: 'The request could not be completed.',
      ...validation,
    };
  }

  const messageClass = classifyMessage(err && err.message);

  if (pgCode === 'P0002') {
    return {
      status: 404,
      code: 'RESOURCE_NOT_FOUND',
      error: 'The requested record could not be found.',
      details: messageClass && messageClass.details,
    };
  }

  if (pgCode === '28000' || pgCode === '42501') {
    return {
      status: 403,
      code: messageClass && messageClass.code !== 'INVALID_OPERATION'
        ? messageClass.code
        : 'OPERATION_NOT_ALLOWED',
      error: 'You do not have permission to perform this action.',
      details: messageClass && messageClass.details,
    };
  }

  if (pgCode === '23505') {
    return mapConstraint(err) || {
      status: 409,
      code: 'DUPLICATE_RECORD',
      error: 'A matching record already exists.',
    };
  }

  if (pgCode === '23503') {
    const action = String(context.action || '').toUpperCase();
    return {
      status: action === 'DELETE' ? 409 : 422,
      code: action === 'DELETE' ? 'RECORD_IN_USE' : 'INVALID_REFERENCE',
      error: action === 'DELETE'
        ? 'The record cannot be deleted because it is referenced.'
        : 'The selected record could not be used.',
    };
  }

  if (pgCode === '23514') {
    return {
      status: 422,
      code: 'VALIDATION_FAILED',
      error: 'The request did not pass validation.',
      details: messageClass && messageClass.details,
    };
  }

  if (pgCode === '23P01') {
    return {
      status: 409,
      code: 'SHIFT_PERIOD_OVERLAP',
      error: 'The shift period overlaps another period.',
      details: 'Choose dates that do not overlap an existing shift period.',
    };
  }

  if (pgCode === '22023' || pgCode === '22000') {
    return {
      status: messageClass && messageClass.status ? messageClass.status : 422,
      code: messageClass && messageClass.code ? messageClass.code : 'INVALID_OPERATION',
      error: 'The request could not be completed.',
      details: messageClass && messageClass.details,
    };
  }

  if (pgCode === 'P0001') {
    if (messageClass) {
      return {
        status: messageClass.status,
        code: messageClass.code,
        error: 'The request could not be completed.',
        details: messageClass.details,
      };
    }
    return {
      status: 422,
      code: 'BUSINESS_RULE_VIOLATION',
      error: 'The request could not be completed.',
    };
  }

  if (pgCode === '08000' || pgCode.startsWith('08') || pgCode === '57P01') {
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      error: 'The server is temporarily unavailable. Please try again later.',
    };
  }

  if (
    pgCode === 'ECONNREFUSED' ||
    pgCode === 'ETIMEDOUT' ||
    pgCode === 'ENOTFOUND' ||
    pgCode === 'ECONNRESET' ||
    pgCode === 'EAI_AGAIN'
  ) {
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      error: 'The server is temporarily unavailable. Please try again later.',
    };
  }

  return null;
}

function sendPostgresError(req, res, err, context = {}) {
  const mapped = mapPostgresError(err, context);
  if (!mapped) {
    return sendInternalError(req, res, err, context.label || 'Database error');
  }

  return sendApiError(req, res, mapped);
}

module.exports = {
  classifyMessage,
  mapPostgresError,
  sendPostgresError,
  stripUnsafeDbTokens,
};
