const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const pool = { query: async () => assert.fail('Unexpected database call') };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
const router = require('../routes/clinical');
const route = router.stack.find(layer => layer.route?.path === '/assignment-board').route;
const handler = route.stack.at(-1).handle;
const request = () => ({ user: { id: 271 }, query: {
  shiftDate: '2026-11-03', shiftTypeId: '1', divisionId: '1', departmentId: '38', clinicalUnitId: '7', userId: '999',
}, rid: 'charge-display' });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; } });

test('charge-role board read retains authentication, screen permission and typed scope checks', async () => {
  const req = request(); req.user = null;
  let res = response(); await handler(req, res); assert.equal(res.statusCode, 401);
  res = response(); await handler({ ...request(), query: { ...request().query, shiftDate: 'bad' } }, res);
  assert.equal(res.statusCode, 400);
  pool.query = async (sql, args) => {
    assert.match(sql, /fn_user_has_permission/);
    assert.deepEqual(args, [271, 'screen:clinical_assignment_board:open']);
    return { rows: [{ ok: false }] };
  };
  res = response(); await route.stack[0].handle(request(), res, () => assert.fail('Permission bypass'));
  assert.equal(res.statusCode, 403);
});

test('live board role projection keeps the saved draft role unchanged without per-staff reads', async () => {
  const board = {
    staff: [{ shift_assignment_id: 417, user_id: 303, is_charge_nurse: false, can_be_charge_nurse: true },
      { shift_assignment_id: 418, user_id: 304, is_charge_nurse: true, can_be_charge_nurse: true }],
    patients: [], workflows: [],
    latest_run: { run: { id: 12, staff_snapshot: [
      { shift_assignment_id: 417, user_id: 303, is_charge_nurse: true },
      { shift_assignment_id: 418, user_id: 304, is_charge_nurse: false },
    ] }, assignments: [] },
  };
  const before = structuredClone(board);
  let calls = 0;
  pool.query = async (sql, args) => {
    calls++;
    assert.deepEqual(args, [271, '2026-11-03', 1, 1, 38, 7]);
    if (sql.includes('fn_clinical_assignment_board(')) {
      assert.match(sql, /WITH scoped_board AS MATERIALIZED/);
      assert.match(sql, /jsonb_set\(payload, '\{staff\}'/);
      assert.match(sql, /ORDER BY staff.ordinality/);
      assert.match(sql, /sa.id = \(staff.value->>'shift_assignment_id'\)::integer/);
      assert.match(sql, /sa.shift_date = \$2::date AND sa.shift_type_id = \$3/);
      assert.match(sql, /sa.division_id = \$4 AND sa.department_id = \$5/);
      return { rows: [{ board: structuredClone(board) }] };
    }
    assert.match(sql, /fn_clinical_assignment_history_summaries/);
    return { rows: [{ rows: [] }] };
  };
  const res = response(); await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ...before, activity: [] });
  assert.equal(calls, 2);
  assert.deepEqual(board, before);
});

test('empty scoped board does not invent a charge nurse or query people separately', async () => {
  let calls = 0;
  pool.query = async (sql) => {
    calls++;
    return { rows: [sql.includes('fn_clinical_assignment_board(')
      ? { board: { staff: [], patients: [], latest_run: null } } : { rows: [] }] };
  };
  const res = response(); await handler(request(), res);
  assert.deepEqual(res.body, { staff: [], patients: [], latest_run: null, activity: [] });
  assert.equal(calls, 2);
});
