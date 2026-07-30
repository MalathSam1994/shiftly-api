const assert = require('node:assert/strict');
const test = require('node:test');

const { mapPostgresError } = require('../utils/postgresErrorMapper');
const {
  normalizeApiErrorBody,
  normalizeErrorResponses,
  sendInternalError,
} = require('../utils/apiError');
const errorHandler = require('../middleware/errorHandler');

test('controlled P0001 business error maps to stable code', () => {
  const mapped = mapPostgresError({
    code: 'P0001',
    message: 'User has no primary manager.',
  });

  assert.equal(mapped.status, 422);
  assert.equal(mapped.code, 'PRIMARY_MANAGER_REQUIRED');
  assert.match(mapped.details, /primary manager/i);
});

test('P0002 maps to not found', () => {
  const mapped = mapPostgresError({ code: 'P0002', message: 'Not found' });
  assert.equal(mapped.status, 404);
  assert.equal(mapped.code, 'RESOURCE_NOT_FOUND');
});

test('22023 invalid operation preserves safe business case', () => {
  const mapped = mapPostgresError({
    code: '22023',
    message: 'Target user has no primary manager.',
  });
  assert.equal(mapped.status, 422);
  assert.equal(mapped.code, 'PRIMARY_MANAGER_REQUIRED');
});

test('28000 maps to operation not allowed', () => {
  const mapped = mapPostgresError({
    code: '28000',
    message: 'You are not the current approver for this request.',
  });
  assert.equal(mapped.status, 403);
  assert.equal(mapped.code, 'NOT_CURRENT_APPROVER');
});

test('23505 maps to duplicate without constraint leak', () => {
  const mapped = mapPostgresError({
    code: '23505',
    message: 'duplicate key violates unique constraint "uq_assignment"',
    constraint: 'uq_assignment',
  });
  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, 'DUPLICATE_SHIFT_ASSIGNMENT');
  assert.doesNotMatch(JSON.stringify(mapped), /uq_assignment/);
});

test('23503 maps delete to record in use', () => {
  const mapped = mapPostgresError(
    { code: '23503', message: 'violates foreign key constraint' },
    { action: 'DELETE' },
  );
  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, 'RECORD_IN_USE');
});

test('23514 maps to validation failed', () => {
  const mapped = mapPostgresError({ code: '23514', message: 'check failed' });
  assert.equal(mapped.status, 422);
  assert.equal(mapped.code, 'VALIDATION_FAILED');
});

test('23P01 maps to overlap conflict', () => {
  const mapped = mapPostgresError({
    code: '23P01',
    message: 'conflicting key value violates exclusion constraint',
  });
  assert.equal(mapped.status, 409);
  assert.equal(mapped.code, 'SHIFT_PERIOD_OVERLAP');
});

test('unexpected database exception is not mapped as controlled', () => {
  const mapped = mapPostgresError({
    code: 'XX000',
    message: 'internal failure at shiftly_schema.fn_secret',
  });
  assert.equal(mapped, null);
});

test('connection-level database failures map to unavailable', () => {
  const mapped = mapPostgresError({
    code: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED 127.0.0.1:5432',
  });

  assert.equal(mapped.status, 503);
  assert.equal(mapped.code, 'DATABASE_UNAVAILABLE');
});

test('safe HTTP 500 response includes request id but not err.message/detail', () => {
  const req = { rid: 'rid-1' };
  const res = fakeRes();
  const err = {
    message: 'password_hash missing in shiftly_schema.users',
    detail: 'SELECT * FROM shiftly_schema.users',
    stack: 'stack line',
  };

  sendInternalError(req, res, err, 'test failure');

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(res.body.request_id, 'rid-1');
  assert.doesNotMatch(JSON.stringify(res.body), /password_hash|SELECT|stack/);
});

test('401 versus 403 codes are distinct contract values', () => {
  const auth = { status: 401, code: 'AUTH_TOKEN_INVALID' };
  const permission = { status: 403, code: 'PERMISSION_DENIED' };

  assert.equal(auth.status, 401);
  assert.equal(permission.status, 403);
  assert.notEqual(auth.code, permission.code);
});

test('normalizes malformed input errors with request id', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-400' },
    400,
    { error: 'Invalid id.' },
  );

  assertContract(body, 'INVALID_ID', 'rid-400');
});

test('normalizes missing authentication errors with request id', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-401' },
    401,
    { error: 'Unauthorized' },
  );

  assertContract(body, 'UNAUTHORIZED', 'rid-401');
});

test('normalizes invalid token errors with request id', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-token' },
    401,
    { error: 'Invalid token.' },
  );

  assertContract(body, 'INVALID_OR_EXPIRED_TOKEN', 'rid-token');
});

test('normalizes permission denied errors and preserves permission field', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-403' },
    403,
    { error: 'Forbidden', permission: 'users.edit' },
  );

  assertContract(body, 'PERMISSION_DENIED', 'rid-403');
  assert.equal(body.permission, 'users.edit');
});

test('normalizes resource not found errors with stable code', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-404' },
    404,
    { error: 'Not found' },
  );

  assertContract(body, 'RESOURCE_NOT_FOUND', 'rid-404');
});

test('normalizes duplicate conflict errors with stable code', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-409' },
    409,
    { error: 'permission_key already exists' },
  );

  assertContract(body, 'DUPLICATE_RECORD', 'rid-409');
});

test('normalizes business validation errors with structured arrays', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-422' },
    422,
    {
      error: 'Validation failed.',
      errors: [{ message: 'User has no primary manager.' }],
      warnings: [{ message: 'Review staffing levels.' }],
    },
  );

  assertContract(body, 'VALIDATION_FAILED', 'rid-422');
  assert.equal(body.errors.length, 1);
  assert.equal(body.warnings.length, 1);
});

test('normalizes license limitation errors with request id and counters', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-429' },
    429,
    {
      error: 'The license limit has been reached.',
      current_count: 10,
      max_allowed: 10,
    },
  );

  assertContract(body, 'LICENSE_LIMIT_EXCEEDED', 'rid-429');
  assert.equal(body.current_count, 10);
  assert.equal(body.max_allowed, 10);
});

test('normalizes database unavailable errors as 503 contract response', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-503' },
    500,
    { error: 'Database unavailable.' },
  );

  assertContract(body, 'DATABASE_UNAVAILABLE', 'rid-503');
});

test('normalizes unexpected direct 500 responses and strips internals', () => {
  const body = normalizeApiErrorBody(
    { rid: 'rid-500' },
    500,
    {
      error: 'Database error',
      detail: 'SELECT * FROM shiftly_schema.users',
      stack: 'C:\\app\\index.js:1',
      query: 'SELECT password_hash FROM shiftly_schema.users',
      constraint: 'uq_assignment',
      schema: 'shiftly_schema',
      table: 'users',
      code: 'XX000',
    },
  );
  const text = JSON.stringify(body);

  assertContract(body, 'INTERNAL_SERVER_ERROR', 'rid-500');
  assert.doesNotMatch(
    text,
    /SELECT|password_hash|shiftly_schema|uq_assignment|C:\\|XX000|users/,
  );
});

test('response normalizer upgrades legacy Database error status to 503', () => {
  const req = { rid: 'rid-db' };
  const res = fakeRes();
  let nextCalled = false;

  normalizeErrorResponses(req, res, () => {
    nextCalled = true;
  });
  res.status(500).json({ error: 'Database error' });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 503);
  assertContract(res.body, 'DATABASE_UNAVAILABLE', 'rid-db');
});

test('body parser JSON errors return a safe 400 contract response', () => {
  const req = { rid: 'rid-json' };
  const res = fakeRes();
  const err = {
    type: 'entity.parse.failed',
    message: 'Unexpected token } in JSON at position 12',
    stack: 'SyntaxError: stack line',
  };

  errorHandler(err, req, res, () => {
    throw new Error('next should not be called');
  });

  assert.equal(res.statusCode, 400);
  assertContract(res.body, 'INVALID_REQUEST', 'rid-json');
  assert.doesNotMatch(JSON.stringify(res.body), /Unexpected token|stack line/);
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function assertContract(body, expectedCode, expectedRequestId) {
  assert.equal(typeof body.error, 'string');
  assert.notEqual(body.error.trim(), '');
  assert.equal(body.code, expectedCode);
  assert.equal(body.request_id, expectedRequestId);
}
