const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const dbPath = require.resolve('../db');
const previousDb = require.cache[dbPath];
const fakePool = { query: async () => { throw new Error('Unexpected query'); } };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
const router = require('../routes/clinical');
if (previousDb) require.cache[dbPath] = previousDb;
else delete require.cache[dbPath];
const handler = path => router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
const exportHandler = handler('/staffing/mappings/export');
const workspaceHandler = handler('/staffing/workspace/:kind');
const response = () => ({
  statusCode: 200, headers: {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; },
  setHeader(key, value) { this.headers[key] = value; },
  append(key, value) { this.headers[key] = [this.headers[key], value].filter(Boolean).join(', '); },
});
const request = query => ({ user: { id: 271 }, query, params: { kind: 'mappings' }, rid: 'records-test' });

test('Excel exports validity per record, renewal history, empty staff and server date without eligibility', async () => {
  fakePool.query = async (sql, values) => {
    assert.match(sql, /fn_clinical_staff_mapping_workspace/);
    assert.equal(values[0], 271);
    assert.deepEqual(JSON.parse(values[1]), { export: 'true', tab: 'expired', attention_issue_id: '24', attention_assignment_id: '498' });
    return { rows: [{ workspace: {
      validity_basis: 'CURRENT_DATE', as_of: '2026-10-14', attention_issue_id: 24, attention_assignment_id: '498',
      rows: [
        { user_name: 'Nurse A', mappings: [
          { competency_name: 'Ventilator', validity: 'Expired', valid_to: '2026-10-13', expires_on: '2026-10-13' },
          { competency_name: 'Ventilator', validity: 'Valid', valid_to: '2027-10-14', expires_on: '2027-10-14' },
        ] },
        { user_name: 'Nurse B', mappings: [] },
      ],
    } }] };
  };
  const res = response();
  await exportHandler(request({ tab: 'expired', attention_issue_id: '24', attention_assignment_id: '498', user_id: '999' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-ShiftMix-Attention-Issue-Id'], '24');
  assert.equal(res.headers['X-ShiftMix-Attention-Assignment-Id'], '498');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(res.body);
  const sheet = workbook.getWorksheet('Staff competencies');
  assert.equal(sheet.rowCount, 4);
  assert.equal(sheet.getCell('G1').value, 'Record validity');
  assert.equal(sheet.getCell('J1').value, 'Validity as of');
  assert.equal(sheet.getCell('K1').value, 'Effective expiry');
  assert.equal(sheet.getCell('G2').value, 'Expired');
  assert.equal(sheet.getCell('G3').value, 'Valid');
  assert.equal(sheet.getCell('D4').value, 'No competencies recorded');
  assert.equal(sheet.getCell('J4').value, '2026-10-14');
  assert(!sheet.getRow(1).values.some(v => /missing|eligib/i.test(v)));
});

test('workspace and export reject a database without the records contract', async () => {
  fakePool.query = async () => ({ rows: [{ workspace: { rows: [], as_of: '2026-10-20' } }] });
  for (const call of [workspaceHandler, exportHandler]) {
    const res = response(); await call(request({}), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'RESOURCE_UNAVAILABLE');
  }
});

test('new records contract still fails closed on missing alert/member echoes', async () => {
  fakePool.query = async () => ({ rows: [{ workspace: { validity_basis: 'CURRENT_DATE', rows: [], attention_issue_id: 24 } }] });
  for (const call of [workspaceHandler, exportHandler]) {
    const res = response(); await call(request({ attention_issue_id: '24', attention_assignment_id: '498' }), res);
    assert.equal(res.statusCode, 503);
  }
});

test('a member filter without its alert is rejected before reading or exporting', async () => {
  fakePool.query = async () => assert.fail('Invalid filter reached database');
  for (const call of [workspaceHandler, exportHandler]) {
    const res = response(); await call(request({ attention_assignment_id: '498' }), res);
    assert.equal(res.statusCode, 400);
  }
});