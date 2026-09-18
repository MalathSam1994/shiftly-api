const assert = require('node:assert/strict');
const test = require('node:test');
const { clinicalOperationalData, clinicalPresentation } = require('../services/clinicalOperationalData');

test('old client writes normalize both patient and initial encounter without changing external provenance', () => {
  const req = { body: { is_demo: true, source_type: ' demo ', encounter: { is_demo: true, source_type: 'EXTERNAL', external_encounter_id: 'DEMO-123' } } };
  let called = false;
  clinicalOperationalData(req, { json() {} }, () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(req.body, { source_type: 'MANUAL', encounter: { source_type: 'EXTERNAL', external_encounter_id: 'DEMO-123' } });
});

test('historical presentation preserves input evidence and identifiers while removing classification labels', () => {
  const original = {
    patient_is_demo: true, encounter_is_demo: true, demo: true,
    patient_public_id: 'DEMO-0001', display_name: 'Demo Patient',
    explanation: {
      rule_set: { name: 'Demo Medical-Surgical', code: 'DEMO_MEDSURG', version: 1 },
      assessment_source_type: 'DEMO', score: 13, workload: 10.5,
      factors: [{ source_type: 'DEMO', factor_value: 2, score_contribution: 8, input_notes: 'Seeded demo acuity factor value.' }],
    },
    notes: 'Keep this free-text clinical note exactly as recorded.',
    recorded_at: new Date('2026-09-18T10:00:00Z'),
  };
  const result = clinicalPresentation(original);
  assert.equal(result.patient_public_id, original.patient_public_id);
  assert.equal(result.display_name, original.display_name);
  assert.equal(result.recorded_at, original.recorded_at);
  assert.equal(result.notes, original.notes);
  assert.equal(result.explanation.rule_set.name, 'Medical-Surgical');
  assert.equal(result.explanation.rule_set.code, 'DEMO_MEDSURG');
  assert.equal(result.explanation.assessment_source_type, 'RECORDED');
  assert.equal(result.explanation.score, 13);
  assert.equal(result.explanation.workload, 10.5);
  assert.deepEqual(result.explanation.factors[0], { source_type: 'RECORDED', factor_value: 2, score_contribution: 8, input_notes: 'Recorded acuity factor value.' });
  for (const key of ['patient_is_demo', 'encounter_is_demo', 'demo']) assert.equal(key in result, false);
  assert.equal(original.explanation.rule_set.name, 'Demo Medical-Surgical');
  assert.equal(original.explanation.assessment_source_type, 'DEMO');
});

test('middleware applies presentation to JSON responses and tolerates reads without a body', () => {
  let received;
  const res = { json(value) { received = value; return this; } };
  clinicalOperationalData({}, res, () => {});
  assert.equal(res.json([{ is_demo: true, id: 4, source_type: 'EXTERNAL' }]), res);
  assert.deepEqual(received, [{ id: 4, source_type: 'EXTERNAL' }]);
});

// Stub the pool: census must include all records even when an old client submits
// the retired filter, and all counts must still be calculated in PostgreSQL.
const dbPath = require.resolve('../db');
const fakePool = { query: async () => { throw new Error('Unexpected query'); } };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
const router = require('../routes/clinical');
const census = router.stack.find(layer => layer.route?.path === '/desktop/patient-census' && layer.route.methods.post).route.stack.at(-1).handle;

test('patient census ignores legacy demo filters and retains the clinical and source filters', async () => {
  fakePool.query = async (sql, values) => {
    assert.doesNotMatch(sql, /patient_is_demo|Demo patients|\$12/);
    assert.match(sql, /Unassessed encounters/);
    assert.match(sql, /patient_source_type=\$9/);
    assert.equal(values.length, 11);
    assert.equal(values[8], 'EXTERNAL');
    return { rows: [{ census: { rows: [{ patient_id: 1 }, { patient_id: 2 }], total: 2 } }] };
  };
  const req = { method: 'POST', user: { id: 271 }, body: { demo: 'true', source: 'EXTERNAL' } };
  const res = { json(value) { this.body = value; return this; } };
  await census(req, res);
  assert.equal(res.body.total, 2);
});
