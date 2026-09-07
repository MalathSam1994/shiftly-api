const assert = require('node:assert/strict');
const test = require('node:test');

// Stub the database before loading routes: these tests never connect to a DB.
const dbPath = require.resolve('../db');
const previousDb = require.cache[dbPath];
const fakePool = { query: async () => { throw new Error('Unexpected query'); } };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
const router = require('../routes/clinical');
if (previousDb) require.cache[dbPath] = previousDb;
else delete require.cache[dbPath];
const route = router.stack.find(layer => layer.route?.path === '/encounters/:encounterId/history').route;
const permission = route.stack[0].handle;
const handler = route.stack[1].handle;
const request = () => ({ user: { sub: '271' }, params: { encounterId: '6' }, query: {}, rid: 'history-test' });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('history requires an authenticated caller', async () => {
  const res = response();
  await permission({ ...request(), user: null }, res, () => assert.fail('Unexpected authorization'));
  assert.equal(res.statusCode, 401);
});
test('history accepts either existing screen permission and rejects neither', async () => {
  fakePool.query = async (sql, values) => {
    assert.equal(values[0], 271);
    assert.deepEqual(values[1], ['screen:clinical_patient_administration:open', 'screen:mobile_clinical_patients:open']);
    return { rows: [{ ok: false }] };
  };
  const res = response();
  await permission(request(), res, () => assert.fail('Unexpected authorization'));
  assert.equal(res.statusCode, 403);
});
test('history uses authenticated actor and bounded pagination', async () => {
  const history = { entries: [], has_more: false };
  fakePool.query = async (sql, values) => {
    assert.match(sql, /fn_clinical_patient_history\(\$1, \$2, \$3\)/);
    assert.deepEqual(values, [271, 6, 100]);
    return { rows: [{ history }] };
  };
  const req = request();
  req.query = { offset: '100', userId: '999' };
  const res = response();
  await handler(req, res);
  assert.deepEqual(res.body, history);
});
test('history rejects invalid offsets without querying', async () => {
  fakePool.query = async () => assert.fail('Invalid offset reached database');
  for (const offset of ['-1', '1.5', 'bad', '2147483648']) {
    const req = request(); req.query.offset = offset;
    const res = response(); await handler(req, res);
    assert.equal(res.statusCode, 400);
  }
});
test('encounter scope rejection is returned as forbidden', async () => {
  fakePool.query = async () => { throw Object.assign(new Error('Patient history is not accessible.'), { code: '42501' }); };
  const res = response(); await handler(request(), res);
  assert.equal(res.statusCode, 403);
});
