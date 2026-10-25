const assert = require('node:assert/strict');
const test = require('node:test');

// Exercise the real route without connecting to the production database.
const dbPath = require.resolve('../db');
const fake = { query: async () => assert.fail('Unexpected database call') };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };
const router = require('../routes/shiftRequests');
const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get)
  .route.stack.at(-1).handle;
const request = query => ({ user: { sub: '271' }, query, rid: 'inbox-scope-test' });
const response = () => ({
  statusCode: 200,
  headers: {},
  status(code) { this.statusCode = code; return this; },
  set(key, value) { this.headers[key] = value; return this; },
  json(body) { this.body = body; return this; },
});
const scope = {
  inboxUserId: '271',
  pendingOnly: 'true',
  shiftDate: '2026-10-25',
  divisionId: '2',
  departmentId: '4',
  shiftTypeId: '6',
  staffTypeId: '8',
};

test('scoped pending inbox filters the full shift tuple and current owner in one SQL query', async () => {
  let calls = 0;
  const row = { id: 20, requested_shift_date: '2026-10-25', request_status: 'PENDING_SOURCE_MANAGER' };
  fake.query = async (sql, values) => {
    calls++;
    assert.deepEqual(values, [2, '2026-10-25', 4, 6, 8, 271]);
    assert.match(sql, /sr\.division_id = \$1/);
    assert.match(sql, /sr\.requested_shift_date = \$2::date/);
    assert.match(sql, /sr\.requested_department_id = \$3::integer/);
    assert.match(sql, /sr\.requested_shift_type_id = \$4::integer/);
    assert.match(sql, /END = \$5::integer/);
    assert.match(sql, /sr\.request_status LIKE 'PENDING%'/);
    assert.match(sql, /sr\.inbox_user_id = \$6/);
    assert.doesNotMatch(sql, /sr\.inbox_user_id IS NULL/);
    return { rows: [row] };
  };
  const res = response();
  await handler(request(scope), res);
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [row]);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('roster staff type uses the requester for a new shift and the assignment for existing shifts', async () => {
  fake.query = async (sql, values) => {
    assert.match(sql, /LEFT JOIN shiftly_schema\.shift_assignments request_assignment\s+ON request_assignment\.id = sr\.shift_assignment_id/);
    assert.match(sql, /CASE WHEN sr\.request_type = 'NEW_SHIFT'\s+THEN requested_by_user\.staff_type_id\s+ELSE COALESCE\(request_assignment\.staff_type_id, requested_by_user\.staff_type_id\)/);
    assert.deepEqual(values, [8, 271]);
    return { rows: [] };
  };
  const res = response();
  await handler(request({ inboxUserId: '271', staffTypeId: '8' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test('scoped manager alias cannot include requests already forwarded to another inbox', async () => {
  fake.query = async (sql, values) => {
    assert.match(sql, /sr\.inbox_user_id = \$1/);
    assert.doesNotMatch(sql, /user_managers|sr\.manager_user_id =/);
    assert.match(sql, /sr\.request_status LIKE 'PENDING%'/);
    assert.deepEqual(values, [271]);
    return { rows: [] };
  };
  const res = response();
  await handler(request({ managerUserId: '271', pendingOnly: 'true' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('scoped inbox requires authentication and rejects another actor before querying', async () => {
  fake.query = async () => assert.fail('Unauthorized lookup reached the database');
  const unauthenticated = response();
  await handler({ ...request(scope), user: null }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  for (const query of [
    { ...scope, inboxUserId: '999' },
    { ...scope, managerUserId: '999' },
    { managerUserId: '999', pendingOnly: 'true' },
  ]) {
    const res = response();
    await handler(request(query), res);
    assert.equal(res.statusCode, 403);
  }
  for (const query of [{ shiftDate: '2026-10-25' }, { requestedByUserId: '271', pendingOnly: 'true' }]) {
    const res = response();
    await handler(request(query), res);
    assert.equal(res.statusCode, 400);
  }
});

test('invalid scope values fail before querying rather than broadening the inbox', async () => {
  fake.query = async () => assert.fail('Invalid lookup reached the database');
  for (const invalid of [
    { shiftDate: '2026-02-30' }, { shiftDate: '2026-1-1' }, { shiftDate: ['2026-10-25'] },
    { shiftDate: '0000-01-01' }, { shiftDate: '' }, { divisionId: '0' },
    { departmentId: '-4' }, { shiftTypeId: '6;DROP TABLE users' },
    { staffTypeId: '2147483648' }, { staffTypeId: ['8'] }, { staffTypeId: true },
    { inboxUserId: '271x' }, { managerUserId: 'NaN' }, { requestedByUserId: '0' },
    { pendingOnly: 'yes' }, { pendingOnly: ['true'] }, { requestStatus: {} },
  ]) {
    const res = response();
    await handler(request({ ...scope, ...invalid }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(invalid));
    assert.equal(res.body.code, 'INVALID_REQUEST');
  }
});

test('unscoped inbox and manager queries retain their existing workflow behavior', async () => {
  const row = { id: 22, requested_shift_date: '2026-10-25', request_status: 'APPROVED' };
  for (const query of [{ inboxUserId: '271' }, { managerUserId: '271' }]) {
    fake.query = async (sql, values) => {
      assert.deepEqual(values, [271]);
      assert.doesNotMatch(sql, /request_status LIKE|request_assignment/);
      if (query.managerUserId) assert.match(sql, /sr\.inbox_user_id IS NULL/);
      return { rows: [row] };
    };
    const res = response();
    await handler(request(query), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, [row]);
  }
});

test('false pending filter preserves historical rows while retaining exact inbox scope', async () => {
  fake.query = async (sql, values) => {
    assert.doesNotMatch(sql, /request_status LIKE/);
    assert.match(sql, /sr\.requested_shift_date = \$1::date/);
    assert.match(sql, /sr\.inbox_user_id = \$2/);
    assert.deepEqual(values, ['2024-02-29', 271]);
    return { rows: [] };
  };
  const res = response();
  await handler(request({ inboxUserId: '271', shiftDate: '2024-02-29', pendingOnly: 'false' }), res);
  assert.equal(res.statusCode, 200);
});
