const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const pool = { query: async () => { throw new Error('Unexpected query'); } };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
const router = require('../routes/clinical');
const response = () => ({ statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

for (const resource of ['factors', 'factor-categories']) {
  for (const method of ['post', 'put']) {
    const route = router.stack.find(layer => layer.route?.path === `/acuity/${resource}${method === 'put' ? '/:id' : ''}` && layer.route.methods[method]).route;
    test(`${method} ${resource} retains icon values, permits reset and requires manage permission`, async () => {
      pool.query = async (sql, values) => {
        assert.deepEqual(values, [271, 'action:clinical_acuity_rules:manage']);
        return { rows: [{ ok: false }] };
      };
      const denied = response();
      await route.stack[0].handle({ user: { id: 271 } }, denied, () => assert.fail('Denied write continued'));
      assert.equal(denied.statusCode, 403);
      for (const icon_key of ['respiratory', null]) {
        pool.query = async (sql, values) => {
          assert.match(sql, /icon_key/);
          assert.equal(values[0], icon_key);
          if (method === 'put') assert.equal(values.at(-1), 42);
          return { rows: [{ id: 42, icon_key }] };
        };
        const res = response();
        await route.stack.at(-1).handle({ params: { id: '42' }, body: { icon_key }, user: { id: 271 } }, res);
        assert.equal(res.statusCode, method === 'put' ? 200 : 201);
        assert.equal(res.body.icon_key, icon_key);
      }
    });
  }
}