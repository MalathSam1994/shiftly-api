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
const availableHandler = handler('/staff-competencies/available');
const response = () => ({
  statusCode: 200, headers: {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; },
  setHeader(key, value) { this.headers[key] = value; },
  append(key, value) { this.headers[key] = [this.headers[key], value].filter(Boolean).join(', '); },
});
const request = query => ({ user: { id: 271 }, query, params: { kind: 'mappings' }, rid: 'records-test' });

test('available competencies use selected staff and actor scope, excluding every existing period', async () => {
  const available = [{ id: 3, competency_name: 'Infusion' }];
  fakePool.query = async (sql, values) => {
    assert.deepEqual(values, [271, 302]);
    assert.match(sql, /fn_clinical_staffing_scoped_users\(\$1\)/);
    assert.match(sql, /NOT EXISTS\s*\([\s\S]*sc.user_id = \$2 AND sc.competency_id = c.id/);
    assert.doesNotMatch(sql, /sc\.(is_active|valid_from|valid_to)|CURRENT_DATE/);
    return { rows: [{ allowed: true, competencies: available }] };
  };
  const res = response();
  await availableHandler(request({ user_id: '302', validity: 'Valid', page: '8' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, available);
});

test('available competencies reject invalid staff and preserve scope failures and empty lists', async () => {
  fakePool.query = async () => assert.fail('Invalid staff reached the database');
  for (const user_id of [undefined, '0', '-1', 'abc', ['302'], '302.5']) {
    const res = response(); await availableHandler(request({ user_id }), res);
    assert.equal(res.statusCode, 400);
  }
  for (const allowed of [false, true]) {
    fakePool.query = async () => ({ rows: [{ allowed, competencies: [] }] });
    const res = response(); await availableHandler(request({ user_id: '302' }), res);
    assert.equal(res.statusCode, allowed ? 200 : 403);
    if (allowed) assert.deepEqual(res.body, []);
  }
});

test('Excel exports validity per record, renewal history, empty staff and server date without eligibility', async () => {
  fakePool.query = async (sql, values) => {
    assert.match(sql, /fn_clinical_staff_mapping_workspace/);
    assert.equal(values[0], 271);
    assert.deepEqual(JSON.parse(values[1]), { export: 'true', tab: 'expired', attention_issue_id: '24', attention_assignment_id: '498' });
    return { rows: [{ workspace: {
      validity_basis: 'CURRENT_DATE', renewal_contract: 1, as_of: '2026-10-14', attention_issue_id: 24, attention_assignment_id: '498',
      rows: [
        { user_name: 'Nurse A', competencies: [{competency_name:'Ventilator',validity:'Valid',expires_on:'2027-10-14'}], mappings: [
          { competency_name: 'Ventilator', validity: 'Expired', valid_to: '2026-10-13', expires_on: '2026-10-13' },
          { competency_name: 'Ventilator', validity: 'Valid', valid_to: '2027-10-14', expires_on: '2027-10-14' },
        ] },
        { user_name: 'Nurse B', competencies: [], mappings: [] },
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
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('E1').value, 'Current validity');
  assert.equal(sheet.getCell('E2').value, 'Valid');
  assert.equal(sheet.getCell('F2').value, '2027-10-14');
  assert.equal(sheet.getCell('D3').value, 'No competencies recorded');
  assert.equal(sheet.getCell('H3').value, '2026-10-14');
  const history = workbook.getWorksheet('Period history');
  assert.equal(history.rowCount, 3);
  assert.equal(history.getCell('E2').value, 'Expired');
  assert.equal(history.getCell('E3').value, 'Valid');
  assert(workbook.getWorksheet('Corrections'));
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
  fakePool.query = async () => ({ rows: [{ workspace: { validity_basis: 'CURRENT_DATE', renewal_contract: 1, rows: [], attention_issue_id: 24 } }] });
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
const renewHandler = handler('/staff-competencies/:id/renew');
const correctHandler = handler('/staff-competencies/:id');
const periodRequest = (body={}) => ({user:{id:271},params:{id:'42'},body:{
  valid_from:'2026-10-15',valid_to:'2027-10-14',source_type:'MANUAL',
  expected_updated_at:'2026-10-14T10:00:00',evidence_reference:'Assessment A',
  ...body,
}});
test('renewal uses the authenticated actor and selected record, never supplied staff identity', async()=>{
 fakePool.query=async(sql,args)=>{
  assert.match(sql,/fn_clinical_staff_competency_period/);
  assert.deepEqual(args.slice(0,3),[271,42,'RENEW']);
  const body=JSON.parse(args[3]); assert(!('user_id' in body)); assert(!('created_by' in body));
  assert.equal(body.evidence_reference,'Assessment A');
  return {rows:[{record:{id:43,renewed_from_id:42}}]};
 };
 const res=response(); await renewHandler(periodRequest({user_id:999,created_by:999}),res);
 assert.equal(res.statusCode,201);assert.equal(res.body.renewed_from_id,42);
});
test('correction requires reason; invalid renewal input never reaches the database',async()=>{
 fakePool.query=async()=>assert.fail('Invalid request reached DB');
 for(const [fn,body] of [[correctHandler,{}],[renewHandler,{evidence_reference:''}],
  [renewHandler,{valid_to:'2026-01-01'}],[renewHandler,{expected_updated_at:null}],
  [renewHandler,{comment:{injected:true}}]]) {
  const res=response();await fn(periodRequest(body),res);assert.equal(res.statusCode,400);
 }
});
test('correction carries reason, actor and optimistic version to the database',async()=>{
 fakePool.query=async(sql,args)=>{assert.equal(args[2],'CORRECT');
  assert.equal(JSON.parse(args[3]).correction_reason,'Certificate date typo');return {rows:[{record:{id:42}}]};};
 const res=response();await correctHandler(periodRequest({correction_reason:'Certificate date typo'}),res);
 assert.equal(res.statusCode,200);
});
test('duplicates and stale edits return a conflict without retrying',async()=>{
 for(const code of ['23505','40001']){
  let calls=0;fakePool.query=async()=>{calls++;throw Object.assign(new Error('conflict'),{code});};
  const res=response();await renewHandler(periodRequest(),res);assert.equal(res.statusCode,409);assert.equal(calls,1);
 }
});
test('workspace rejects the older records contract even when its date basis matches',async()=>{
 fakePool.query=async()=>({rows:[{workspace:{validity_basis:'CURRENT_DATE',rows:[]}}]});
 const res=response();await workspaceHandler(request({}),res);assert.equal(res.statusCode,503);
});
