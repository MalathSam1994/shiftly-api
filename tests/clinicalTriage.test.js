const assert = require('node:assert/strict');
const test = require('node:test');
const { triageFilters, triageRecordBody, attachTriageSnapshots, attachRunTriageSnapshots } = require('../services/clinicalTriage');
const { mapPostgresError } = require('../utils/postgresErrorMapper');
// No production database connections: every query is observed or rejected.
const dbPath = require.resolve('../db');
const fake = { query: async () => assert.fail('Unexpected database call') };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };
const router = require('../routes/clinical');
const route = (path, method = 'get') => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
const handler = (path, method) => route(path, method).stack.at(-1).handle;
const req = (body = {}, params = { encounterId: '12' }) => ({ user: { sub: '271' }, params, body, query: {}, rid: 'triage-test' });
const res = () => ({ statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
  set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } });
const record = { action: 'RECORD', level: 3, expected_revision: 0, expected_episode_id: 18 };

test('workspace and record require dedicated permissions, while detail accepts existing patient readers', async () => {
  for (const [path, method, permission] of [
    ['/triage/workspace', 'get', 'screen:clinical_triage:open'],
    ['/triage/workspace', 'post', 'screen:clinical_triage:open'],
    ['/triage/patients/:encounterId', 'post', 'action:clinical_triage:record'],
  ]) {
    fake.query = async (sql, values) => { assert.deepEqual(values, [271, permission]); return { rows: [{ ok: false }] }; };
    const response = res(); await route(path, method).stack[0].handle(req(), response, () => assert.fail('Permission bypass'));
    assert.equal(response.statusCode, 403);
  }
  fake.query = async (sql, values) => {
    assert.deepEqual(values, [271, ['screen:clinical_triage:open', 'screen:clinical_patient_administration:open',
      'screen:mobile_clinical_patients:open', 'screen:clinical_assignment_board:open']]);
    return { rows: [{ ok: true }] };
  };
  let allowed = false;
  await route('/triage/patients/:encounterId').stack[0].handle(req(), res(), () => { allowed = true; });
  assert.equal(allowed, true);
});

test('unauthenticated calls never query', async () => {
  fake.query = async () => assert.fail('Unauthenticated query');
  for (const [path, method] of [['/triage/workspace', 'get'], ['/triage/patients/:encounterId', 'get'], ['/triage/patients/:encounterId', 'post']]) {
    const response = res(); await handler(path, method)({ ...req(record), user: null }, response);
    assert.equal(response.statusCode, 401);
  }
});

test('record uses authenticated actor, revision and episode and server-owned provenance', async () => {
  fake.query = async (sql, values) => {
    assert.match(sql, /fn_clinical_triage_record/); assert.equal(values[0], 271); assert.equal(values[1], 12);
    assert.deepEqual(JSON.parse(values[2]), { ...record, source: 'MANUAL', reason: null, effective_at: null });
    return { rows: [{ detail: { triage: { level: 3, revision: 1 } } }] };
  };
  const response = res(); await handler('/triage/patients/:encounterId', 'post')(req({ ...record, actor: 999, assessed_by: 999 }), response);
  assert.equal(response.statusCode, 200); assert.equal(response.body.triage.level, 3);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('bad types, missing guards, forged provenance and future timestamps cannot reach SQL', async () => {
  fake.query = async () => assert.fail('Invalid input reached SQL');
  const invalids = [null, [], { ...record, level: true }, { ...record, level: '3' }, { ...record, level: 0 },
    { ...record, level: 6 }, { ...record, level: 1.5 }, { ...record, expected_revision: '0' },
    { ...record, expected_revision: -1 }, { ...record, expected_episode_id: null },
    { ...record, action: 'CORRECT' }, { ...record, action: 'ESCALATE', reason: [] },
    { ...record, source: 'EXTERNAL' }, { ...record, effective_at: '2999-01-01T10:00:00Z' },
    { ...record, effective_at: '2026-02-30T10:00:00Z' }, { ...record, effective_at: '2020-01-01T24:00:00Z' },
    { ...record, effective_at: '2020-01-01T10:00:00' }, { ...record, level: 2, esi_level: 3 }, { ...record, reason: 'x'.repeat(1001) }];
  for (const body of invalids) {
    const response = res(); await handler('/triage/patients/:encounterId', 'post')(req(body), response);
    assert.equal(response.statusCode, 400, JSON.stringify(body)); assert.equal(response.body.code, 'CLINICAL_TRIAGE_INVALID');
  }
  assert.equal(triageRecordBody({ ...record, action: 'CORRECT', reason: ' Wrong entry ' }).reason, 'Wrong entry');
  assert.equal(triageRecordBody({ ...record, action: 'CARE_STARTED', level: null }).level, null);
  assert.throws(() => triageRecordBody({ ...record, action: 'CARE_STARTED' }));
});

test('workspace filters are typed and bounded and never choose the actor', async () => {
  const filters = { unit_id: 8, level: 2, search: 'example', unrecorded: false };
  fake.query = async (sql, values) => {
    assert.match(sql, /fn_clinical_triage_workspace/); assert.deepEqual(values, [271, JSON.stringify(filters)]);
    return { rows: [{ workspace: { patients: [], distribution: { total: 0 } } }] };
  };
  const response = res();
  await handler('/triage/workspace')({ ...req(), query: { unitId: '8', level: '2', search: ' example ', userId: '999' } }, response);
  assert.equal(response.statusCode, 200); assert.equal(response.headers['Cache-Control'], 'no-store');
  const searchResponse = res();
  await handler('/triage/workspace', 'post')({ ...req({ unitId: '8', level: '2', search: 'example' }), method: 'POST', query: { search: 'ignored URL query' } }, searchResponse);
  assert.equal(searchResponse.statusCode, 200);
  for (const query of [{ unitId: [] }, { unitId: '2147483648' }, { level: true }, { level: '6' },
    { search: {} }, { search: 'x'.repeat(161) }, { unrecorded: 'yes' }, { level: '2', unrecorded: true }]) assert.throws(() => triageFilters(query));
});

test('census triage filters run on the complete cohort before pagination', async () => {
  fake.query = async (sql, values) => {
    assert.ok(sql.indexOf("triage->>'level'") < sql.indexOf('LIMIT 100 OFFSET'));
    assert.match(sql, /fn_clinical_triage_snapshots/); assert.equal(values[0], 271);
    assert.deepEqual(values.slice(-2), [2, false]); return { rows: [{ census: { rows: [], total: 0 } }] };
  };
  const response = res(); await handler('/desktop/patient-census', 'post')({ ...req({ triageLevel: '2' }), method: 'POST' }, response);
  assert.equal(response.statusCode, 200);
});

test('known database refusals remain actionable without private database details', async () => {
  for (const [hint, status] of [['CLINICAL_TRIAGE_STALE', 409], ['CLINICAL_TRIAGE_CARE_STARTED', 409],
    ['CLINICAL_TRIAGE_FORBIDDEN', 403], ['CLINICAL_TRIAGE_NOT_FOUND', 404], ['CLINICAL_TRIAGE_ED_ONLY', 422]]) {
    fake.query = async () => { throw Object.assign(new Error('private SQL and patient details'), { code: 'P0001', hint }); };
    const response = res(); await handler('/triage/patients/:encounterId', 'post')(req(record), response);
    assert.equal(response.statusCode, status); assert.equal(response.body.code, hint); assert.doesNotMatch(response.body.error, /private SQL/);
  }
  assert.equal(mapPostgresError({ code: '40001' }).status, 409);
  assert.equal(mapPostgresError({ code: '42501', hint: 'CLINICAL_TRIAGE_FORBIDDEN' }).code, 'CLINICAL_TRIAGE_FORBIDDEN');
});

test('batched snapshot attachment preserves scores, persisted snapshots and historical evidence', async () => {
  const input = { patients: [{ encounter_id: 12, workload: 14, score: 7 }, { encounterId: '12' }, { id: 99 },
    { encounter_id: 14, triage: { level: 4 } }], history: [{ encounter_id: 15, triage: { level: 1 } }], run: { evidence_hash: 'unchanged' } };
  const asOf = '2020-01-01T12:00:00Z'; let calls = 0;
  const db = { query: async (sql, values) => {
    calls++; assert.match(sql, /fn_clinical_triage_snapshots/); assert.deepEqual(values, [271, [12], asOf]);
    return { rows: [{ snapshots: { 12: { applicable: true, level: 2 } } }] };
  } };
  const output = await attachTriageSnapshots(db, 271, input, { asOf });
  assert.equal(calls, 1); assert.equal(output.patients[0].triage.level, 2);
  assert.equal(output.patients[0].workload, 14); assert.equal(output.patients[0].score, 7);
  assert.equal(input.patients[0].triage, undefined); assert.equal(output.patients[1].triage.level, 2);
  assert.equal(output.patients[2].triage, undefined); assert.equal(output.patients[3].triage.level, 4);
  assert.equal(output.history, input.history); assert.equal(output.run.evidence_hash, 'unchanged');
});

test('no encounter IDs means no extra query; missing ESI is never defaulted to level 5', async () => {
  assert.deepEqual(await attachTriageSnapshots({ query: async () => assert.fail('Unexpected query') }, 271, { id: 3 }), { id: 3 });
  const output = await attachTriageSnapshots({ query: async () => ({ rows: [{ snapshots: {} }] }) }, 271, [{ encounter_id: 12 }]);
  assert.equal(output[0].triage, undefined);
});

test('optimizer saved evidence is untouched and run assignment ESI uses generation time', async () => {
  const run = { generated_at: '2020-01-01T10:00:00', input_snapshot: { patients: [{ encounter_id: 13 }] },
    patient_snapshot: [{ encounter_id: 14 }] };
  const explanation = { encounter_id: 15, workload: 9 };
  const payload = { run, assignments: [{ encounter_id: 12, patient_workload: 9, acuity_explanation: explanation }] };
  const db = { query: async (sql, values) => {
    assert.deepEqual(values, [271, [12], run.generated_at]);
    return { rows: [{ snapshots: { 12: { applicable: true, level: 3 } } }] };
  } };
  const output = await attachRunTriageSnapshots(db, 271, payload);
  assert.equal(output.run, run); assert.equal(output.assignments[0].acuity_explanation, explanation);
  assert.equal(output.assignments[0].triage.level, 3); assert.equal(output.assignments[0].patient_workload, 9);
});

test('historical and non-current explicit-shift mobile lists never receive live triage', async () => {
  for (const query of [{ scope: 'HISTORY' }, { scope: 'ALL' }, { shiftAssignmentId: '27' }]) {
    fake.query = async sql => { assert.match(sql, /fn_clinical_mobile_my_patients/); return { rows: [{ encounter_id: 12 }] }; };
    const response = res(); await handler('/mobile/my-patients')({ ...req(), query }, response);
    assert.equal(response.statusCode, 200); assert.equal(response.body[0].triage, undefined);
  }
});

test('explicit running shift uses canonical DB context before batching live ESI', async () => {
  fake.query = async (sql, values) => {
    if (sql.includes('fn_clinical_mobile_my_patients')) {
      assert.match(sql, /fn_clinical_published_patient_contexts\(\$1\)/);
      assert.match(sql, /pa\.assignment_status = 'PUBLISHED' AND pa\.ended_at IS NULL/);
      assert.deepEqual(values, [271, 'CURRENT', 27]);
      return { rows: [{ encounter_id: 12, triage_live_context: true }, { encounter_id: 13, triage_live_context: false }] };
    }
    assert.match(sql, /fn_clinical_triage_snapshots/); assert.deepEqual(values, [271, [12], null]);
    return { rows: [{ snapshots: { 12: { applicable: true, level: 2 } } }] };
  };
  const response = res(); await handler('/mobile/my-patients')({ ...req(), query: { scope: 'CURRENT', shiftAssignmentId: '27' } }, response);
  assert.equal(response.statusCode, 200); assert.equal(response.body[0].triage.level, 2);
  assert.equal(response.body[1].triage, undefined); assert.equal(response.body[0].triage_live_context, undefined);
});

test('mobile patient reads attach ED applicability separately from workload in one batch', async () => {
  let calls = 0;
  fake.query = async (sql, values) => {
    calls++;
    if (sql.includes('fn_clinical_mobile_patient_encounters')) return { rows: [{ encounter_id: 12, workload: 8 }, { encounter_id: 13, workload: 5 }] };
    assert.match(sql, /fn_clinical_triage_snapshots/); assert.deepEqual(values, [271, [12, 13], null]);
    return { rows: [{ snapshots: { 12: { applicable: true, level: null }, 13: { applicable: false, level: null } } }] };
  };
  const response = res(); await handler('/mobile/patients')(req(), response);
  assert.equal(calls, 2); assert.equal(response.body[0].triage.level, null);
  assert.equal(response.body[1].triage.applicable, false); assert.equal(response.body[0].workload, 8);
});

const dashboard = require('../query/clinicalDashboard');
const dashboardHandler = path => dashboard.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
test('dashboard distribution uses the server-selected cohort, not the capped priority preview', async () => {
  for (const mode of ['mobile', 'manager']) {
    const base = mode === 'mobile' ? { applicable: true, shift: { shift_assignment_id: 27 }, priority_patients: [] }
      : { applicable: true, scope: { clinical_unit_id: 8, division_id: 3, department_id: 4 }, action_items: [] };
    const expected = mode === 'mobile' ? { mode, shift_assignment_id: 27 } : { mode, unit_id: 8, division_id: 3, department_id: 4 };
    fake.query = async (sql, values) => {
      if (sql.includes(`fn_${mode}_clinical_dashboard_summary`)) return { rows: [{ summary: base }] };
      assert.match(sql, /fn_clinical_triage_summary/); assert.deepEqual(values, [271, JSON.stringify(expected)]);
      return { rows: [{ distribution: { levels: [{ level: 2, count: 8 }], total: 12, unrecorded: 4 } }] };
    };
    const response = res(); await dashboardHandler(`/${mode}/clinical-summary`)({ ...req(), query: { userId: '999', shift_assignment_id: '999' } }, response);
    assert.equal(response.statusCode, 200); assert.equal(response.body.triage_distribution.total, 12);
    assert.equal(response.body.triage_distribution.unrecorded, 4);
  }
});
