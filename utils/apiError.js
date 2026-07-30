const DEFAULT_INTERNAL_MESSAGE =
  'Something went wrong while processing the request.';

function requestId(req) {
  return req && req.rid ? String(req.rid) : undefined;
}

function compactBody(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

function isRawSqlState(code) {
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

function messageText(body) {
  if (!body || typeof body !== 'object') return '';
  const value = body.error ?? body.message ?? body.details ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function inferErrorCode(status, body = {}) {
  const current = body && typeof body === 'object' ? body.code : undefined;
  if (current && !isRawSqlState(current)) return current;

  const msg = messageText(body).toLowerCase();

  if (status === 400) {
    if (msg.includes('required')) return 'REQUIRED_FIELD_MISSING';
    if (msg.includes('invalid id') || msg.includes('id must')) return 'INVALID_ID';
    return 'INVALID_REQUEST';
  }
  if (status === 401) {
    if (msg.includes('expired') || msg.includes('invalid token')) {
      return 'INVALID_OR_EXPIRED_TOKEN';
    }
    if (msg.includes('session')) return 'SESSION_REPLACED';
    return 'UNAUTHORIZED';
  }
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 409) {
    if (msg.includes('in use') || msg.includes('referenced')) return 'RECORD_IN_USE';
    if (msg.includes('duplicate') || msg.includes('already exists')) {
      return 'DUPLICATE_RECORD';
    }
    return 'CONFLICT';
  }
  if (status === 422) {
    if (msg.includes('validation')) return 'VALIDATION_FAILED';
    return 'INVALID_OPERATION';
  }
  if (status === 429) {
    if (msg.includes('license')) return 'LICENSE_LIMIT_EXCEEDED';
    return 'RATE_LIMIT_EXCEEDED';
  }
  if (status === 502 || status === 503 || status === 504) {
    if (msg.includes('database')) return 'DATABASE_UNAVAILABLE';
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (status >= 500) {
    if (msg.includes('database') && !body.code) return 'DATABASE_UNAVAILABLE';
    return 'INTERNAL_SERVER_ERROR';
  }
  return 'ERROR';
}

function fallbackErrorMessage(status, body = {}) {
  const msg = messageText(body);
  const code = inferErrorCode(status, body);

  if (status >= 500) {
    if (code === 'DATABASE_UNAVAILABLE') {
      return 'The database is temporarily unavailable. Please try again later.';
    }
    if (body && body.code && !isRawSqlState(body.code) && msg) return msg;
    return DEFAULT_INTERNAL_MESSAGE;
  }

  if (msg) {
    if (msg.toLowerCase() === 'not found') {
      return 'The requested record was not found.';
    }
    if (msg.toLowerCase() === 'forbidden') {
      return 'You do not have permission to perform this action.';
    }
    if (msg.toLowerCase() === 'unauthorized') {
      return 'Please sign in to continue.';
    }
    return msg;
  }

  const messages = {
    INVALID_REQUEST: 'The request contains invalid fields.',
    INVALID_ID: 'The requested identifier is invalid.',
    REQUIRED_FIELD_MISSING: 'A required field is missing.',
    UNAUTHORIZED: 'Please sign in to continue.',
    INVALID_OR_EXPIRED_TOKEN: 'Your session has expired. Please sign in again.',
    SESSION_REPLACED: 'Your session was replaced by a newer sign-in.',
    PERMISSION_DENIED: 'You do not have permission to perform this action.',
    RESOURCE_NOT_FOUND: 'The requested record was not found.',
    DUPLICATE_RECORD: 'A matching record already exists.',
    RECORD_IN_USE: 'The record is in use and cannot be changed.',
    VALIDATION_FAILED: 'The request could not be completed.',
    INVALID_OPERATION: 'The operation cannot be completed.',
    CONFLICT: 'The request conflicts with the current data.',
    RATE_LIMIT_EXCEEDED: 'Too many requests. Please try again later.',
    LICENSE_LIMIT_EXCEEDED: 'The license limit has been reached.',
    DATABASE_UNAVAILABLE: 'The database is temporarily unavailable.',
    UPSTREAM_UNAVAILABLE: 'A required service is temporarily unavailable.',
  };

  return messages[code] || 'The request could not be completed.';
}

function normalizeApiErrorBody(req, status, body) {
  if (status < 400 || !body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'error') &&
      !Object.prototype.hasOwnProperty.call(body, 'message')) {
    return body;
  }

  const code = inferErrorCode(status, body);
  const normalized = {
    ...body,
    error: fallbackErrorMessage(status, body),
    code,
    request_id: requestId(req),
  };

  if (Object.prototype.hasOwnProperty.call(normalized, 'message') &&
      !Object.prototype.hasOwnProperty.call(body, 'error')) {
    delete normalized.message;
  }

  if (status >= 500) {
    delete normalized.detail;
    delete normalized.details;
    delete normalized.stack;
    delete normalized.sql;
    delete normalized.query;
    delete normalized.constraint;
    delete normalized.table;
    delete normalized.schema;
    delete normalized.routine;
    delete normalized.where;
  }

  return compactBody(normalized);
}

function normalizeErrorResponses(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const status = res.statusCode || 200;
    const normalized = normalizeApiErrorBody(req, status, body);
    if (status === 500 && normalized && normalized.code === 'DATABASE_UNAVAILABLE') {
      res.status(503);
    }
    return originalJson(normalized);
  };

  next();
}

function normalizeValidationPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { errors: [], warnings: [] };
  }

  const validation = payload.validation_errors;
  const errors =
    Array.isArray(payload.errors)
      ? payload.errors
      : Array.isArray(validation)
        ? validation
        : validation && Array.isArray(validation.errors)
          ? validation.errors
          : [];
  const warnings =
    Array.isArray(payload.warnings)
      ? payload.warnings
      : validation && Array.isArray(validation.warnings)
        ? validation.warnings
        : [];

  return {
    errors,
    warnings,
    validation_errors: validation,
  };
}

function sendApiError(
  req,
  res,
  {
    status = 500,
    error = DEFAULT_INTERNAL_MESSAGE,
    code = 'INTERNAL_SERVER_ERROR',
    details,
    errors = [],
    warnings = [],
    validation_errors,
    extra,
  } = {},
) {
  const body = compactBody({
    error,
    code,
    details,
    errors,
    warnings,
    validation_errors,
    ...(extra && typeof extra === 'object' ? extra : {}),
    request_id: requestId(req),
  });

  return res.status(status).json(body);
}

function sendValidationError(req, res, payload = {}, options = {}) {
  const normalized = normalizeValidationPayload(payload);
  return sendApiError(req, res, {
    status: options.status || 422,
    error: options.error || 'The request could not be completed.',
    code: options.code || 'VALIDATION_FAILED',
    details: options.details,
    errors: normalized.errors,
    warnings: normalized.warnings,
    validation_errors: normalized.validation_errors,
  });
}

function logError(req, label, err, extra = {}) {
  const safeLabel = label || 'Unhandled error';
  console.error(`[${requestId(req) || 'no-rid'}] ${safeLabel}`, {
    message: err && err.message,
    code: err && err.code,
    detail: err && err.detail,
    hint: err && err.hint,
    constraint: err && err.constraint,
    table: err && err.table,
    column: err && err.column,
    schema: err && err.schema,
    routine: err && err.routine,
    where: err && err.where,
    stack: err && err.stack,
    ...extra,
  });
}

function sendInternalError(req, res, err, label) {
  logError(req, label || 'Internal server error', err);
  return sendApiError(req, res, {
    status: 500,
    error: DEFAULT_INTERNAL_MESSAGE,
    code: 'INTERNAL_SERVER_ERROR',
  });
}

module.exports = {
  DEFAULT_INTERNAL_MESSAGE,
  logError,
  normalizeApiErrorBody,
  normalizeErrorResponses,
  normalizeValidationPayload,
  sendApiError,
  sendInternalError,
  sendValidationError,
};
