const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const fakePool = {query: async () => {throw new Error('Unexpected query');}};
require.cache[dbPath] = {id: dbPath, filename: dbPath, loaded: true, exports: fakePool};
const router = require('../routes/clinical');
const route = router.stack.find(layer => layer.route?.path === '/acuity/rule-sets/:id/revisions').route;
const handler = route.stack.at(-1).handle;
const request = () => ({user: {sub: '271'}, params: {id: '4'}, body: {actor: 999}, rid: 'revision-test'});
const response = () => ({statusCode: 200, status(code) {this.statusCode = code; return this;}, json(body) {this.body = body; return this;}});

test('revision action requires rule screen and manage permissions', async () => {
  for (const [index, key] of ['screen:clinical_acuity_rule_sets:open', 'action:clinical_acuity_rules:manage'].entries()) {
    fakePool.query = async (sql, values) => {
      assert.deepEqual(values, [271, key]); return {rows: [{ok: false}]};
    };
    const res = response();
    await route.stack[index].handle(request(), res, () => assert.fail('Denied action continued'));
    assert.equal(res.statusCode, 403);
  }
});

test('invalid revision source does not reach the database', async () => {
  fakePool.query = async () => assert.fail('Invalid source queried');
  for (const id of ['0', '-1', '4junk', '2147483648']) {
    const res = response();
    await handler({...request(), params: {id}}, res);
    assert.equal(res.statusCode, 400);
  }
});

test('revision uses authenticated actor and returns the editable draft', async () => {
  const draft = {id: 5, previous_rule_set_id: 4, status: 'DRAFT', version_number: 2};
  fakePool.query = async (sql, values) => {
    assert.match(sql, /fn_clinical_create_rule_set_revision/);
    assert.deepEqual(values, [4, 271]); return {rows: [draft]};
  };
  const res = response(); await handler(request(), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, draft);
});

for (const [hint, status] of [
  ['CLINICAL_ACUITY_REVISION_SOURCE_UNAVAILABLE', 404],
  ['CLINICAL_ACUITY_REVISION_REQUIRES_PUBLISHED', 409],
]) {
  test('revision reports ' + hint + ' without database details', async () => {
    fakePool.query = async () => {throw Object.assign(new Error('Private database details'), {code: 'P0001', hint});};
    const res = response(); await handler(request(), res);
    assert.equal(res.statusCode, status); assert.equal(res.body.code, hint);
    assert.doesNotMatch(JSON.stringify(res.body), /Private database details/);
  });
}
