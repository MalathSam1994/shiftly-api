const assert = require('node:assert/strict');
const test = require('node:test');

// Exercise the real route handlers, permission middleware and scope checks without a live DB.
const dbPath = require.resolve('../db');
const fakePool = { query: async () => { throw new Error('Unexpected query'); } };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
const router = require('../routes/clinical');
const routes = {
  post: router.stack.find(layer => layer.route?.path === '/assignment-optimizer-policies' && layer.route.methods.post).route,
  put: router.stack.find(layer => layer.route?.path === '/assignment-optimizer-policies/:id' && layer.route.methods.put).route,
  get: router.stack.find(layer => layer.route?.path === '/assignment-optimizer-policies' && layer.route.methods.get).route,
  workspace: router.stack.find(layer => layer.route?.path === '/assignment-optimizer-policies/workspace').route,
};
const request = (method, body = {}) => ({
  user: { id: 271 }, params: method === 'put' ? { id: '42' } : {},
  body, query: {}, rid: 'optimizer-history-test',
});
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

async function invoke(method, req) {
  const res = response();
  for (const layer of routes[method].stack) {
    let continued = false;
    await layer.handle(req, res, () => { continued = true; });
    if (!continued) break;
  }
  return res;
}

function allowPolicyWrite(write, { currentVisible = true, proposedAllowed = true } = {}) {
  fakePool.query = async (sql, values) => {
    if (/fn_user_has_permission/.test(sql)) {
      assert.deepEqual(values, [271, 'action:clinical_assignments:publish']);
      return { rows: [{ ok: true }] };
    }
    if (/SELECT p.clinical_unit_id/.test(sql)) {
      assert.deepEqual(values, [271, 42]);
      assert.match(sql, /fn_user_can_access_division_department/);
      return { rows: currentVisible ? [{ clinical_unit_id: 7, division_id: 2, department_id: 3 }] : [] };
    }
    if (/SELECT EXISTS/.test(sql)) {
      assert.equal(values[0], 271);
      assert.match(sql, /fn_user_can_access_division_department/);
      return { rows: [{ ok: proposedAllowed }] };
    }
    return write(sql, values);
  };
}

for (const method of ['post', 'put']) {
  for (const enabled of [true, false]) {
    test(`${method} saves an explicit history priority value of ${enabled}`, async () => {
      let writes = 0;
      allowPolicyWrite(async (sql, values) => {
        writes++;
        assert.match(sql.trimStart(), method === 'post' ? /^INSERT INTO/ : /^UPDATE/);
        assert.match(sql, /history_priority_enabled/);
        assert(values.includes(enabled));
        return { rows: [{ id: 42, policy_name: 'History policy', history_priority_enabled: enabled }] };
      });
      const res = await invoke(method, request(method, { policy_name: 'History policy', history_priority_enabled: enabled }));
      assert.equal(res.statusCode, method === 'post' ? 201 : 200);
      assert.equal(res.body.history_priority_enabled, enabled);
      assert.equal(writes, 1);
    });
  }

  test(`${method} rejects non-boolean history priority before scope checks or writes`, async () => {
    let permissionChecks = 0;
    fakePool.query = async (sql, values) => {
      assert.match(sql, /fn_user_has_permission/);
      assert.deepEqual(values, [271, 'action:clinical_assignments:publish']);
      permissionChecks++;
      return { rows: [{ ok: true }] };
    };
    const invalid = [null, 'true', 'false', '', 0, 1, {}, []];
    for (const value of invalid) {
      const res = await invoke(method, request(method, { policy_name: 'Policy', history_priority_enabled: value }));
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVALID_REQUEST');
      assert.match(res.body.error, /history_priority_enabled must be true or false/);
    }
    assert.equal(permissionChecks, invalid.length);
  });
}

test('create omission delegates to the disabled database default', async () => {
  allowPolicyWrite(async (sql, values) => {
    assert.match(sql.trimStart(), /^INSERT INTO/);
    assert.doesNotMatch(sql, /history_priority_enabled/);
    assert.deepEqual(values, ['Policy']);
    return { rows: [{ id: 42, history_priority_enabled: false }] };
  });
  const res = await invoke('post', request('post', { policy_name: 'Policy' }));
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.history_priority_enabled, false);
});

test('update omission preserves the existing enabled value', async () => {
  allowPolicyWrite(async (sql, values) => {
    assert.match(sql.trimStart(), /^UPDATE/);
    assert.doesNotMatch(sql, /history_priority_enabled/);
    assert.deepEqual(values, ['Renamed policy', 42]);
    return { rows: [{ id: 42, policy_name: 'Renamed policy', history_priority_enabled: true }] };
  });
  const res = await invoke('put', request('put', { policy_name: 'Renamed policy' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.history_priority_enabled, true);
});

test('history priority writes still require authentication and publish permission', async () => {
  for (const method of ['post', 'put']) {
    fakePool.query = async () => assert.fail('Unauthenticated request reached the database');
    const unauthenticated = request(method, { history_priority_enabled: true });
    unauthenticated.user = null;
    assert.equal((await invoke(method, unauthenticated)).statusCode, 401);
    fakePool.query = async (sql, values) => {
      assert.match(sql, /fn_user_has_permission/);
      assert.deepEqual(values, [271, 'action:clinical_assignments:publish']);
      return { rows: [{ ok: false }] };
    };
    const res = await invoke(method, request(method, { history_priority_enabled: true }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'PERMISSION_DENIED');
  }
});

test('history priority cannot update a policy outside the existing manager scope', async () => {
  allowPolicyWrite(async () => assert.fail('Out-of-scope policy was written'), { currentVisible: false });
  const res = await invoke('put', request('put', { history_priority_enabled: true }));
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'RESOURCE_NOT_FOUND');
});

test('history priority cannot create or move a policy into an unauthorized scope', async () => {
  for (const method of ['post', 'put']) {
    allowPolicyWrite(async () => assert.fail('Unauthorized scope was written'), { proposedAllowed: false });
    const res = await invoke(method, request(method, { clinical_unit_id: 999, history_priority_enabled: true }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
});

test('policy list and workspace return the persisted history priority setting', async () => {
  const policy = { id: 42, history_priority_enabled: true };
  for (const method of ['get', 'workspace']) {
    fakePool.query = async (sql, values) => {
      if (/SELECT shiftly_api.fn_user_has_permission/.test(sql)) {
        assert.deepEqual(values, [271, 'screen:clinical_assignment_optimizer_policies:open']);
        return { rows: [{ ok: true }] };
      }
      assert.equal(values[0], 271);
      assert.match(sql, /p\.\*/);
      return { rows: method === 'get' ? [policy] : [{ workspace: { rows: [policy], can_manage: true } }] };
    };
    const res = await invoke(method, request(method));
    assert.equal(res.statusCode, 200);
    assert.equal((method === 'get' ? res.body : res.body.rows)[0].history_priority_enabled, true);
  }
});
