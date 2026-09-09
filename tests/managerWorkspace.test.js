const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const fake = { query: async () => ({ rows: [] }), release() {} };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { connect: async () => fake } };
const router = require('../query/clinicalDashboard');
const handler = router.stack.find(l => l.route?.path === '/manager/workspace').route.stack[0].handle;
const response = () => ({ statusCode: 200, headers: {}, type() { return this; }, send(v) { this.body = v; return this; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; }, set(k,v) { this.headers[k] = v; return this; } });
const request = query => ({ user: { sub: '271' }, query, path: '/manager/workspace' });
test('workspace requires authentication', async () => {
 const res = response(); await handler({ ...request({}), user: null }, res); assert.equal(res.statusCode, 401);
});
test('workspace rejects invalid dates, ranges and identifiers before DB access', async () => {
 fake.query = async () => assert.fail('Invalid request reached DB');
 for (const query of [{ from: '2026-02-30' }, { from: '2026-09-01', to: '2026-09-01' },
 { from: '2026-09-01', to: '2026-11-01' }, { to: '2026-09-02' }, { unitId: '-1' }, { unitId: '2147483648' },
 { shiftTypeId: '1;DROP TABLE users' }, { staffTypeId: ['1','2'] }]) {
  const res = response(); await handler(request(query), res); assert.equal(res.statusCode, 400, JSON.stringify(query));
 }
});
test('one snapshot query uses authenticated actor, typed filters and no-store', async () => {
 let count = 0;
 const snapshot = { kpis: { patients: 0 } };
 fake.query = async (sql, values) => {
  if (sql.includes('fn_manager_dashboard_workspace')) {
   count++; assert.deepEqual(values, [271, '2026-09-01', '2026-09-02', 3, 4, 5]);
   assert.match(sql, /\$6::integer/); return { rows: [{ snapshot }] };
  } return { rows: [] };
 };
 const res = response(); await handler(request({ userId: '999', from:'2026-09-01',to:'2026-09-02',unitId:'3',shiftTypeId:'4',staffTypeId:'5' }), res);
 assert.equal(count, 1); assert.deepEqual(res.body, snapshot); assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('database scope denial remains forbidden', async () => {
 fake.query = async sql => { if (sql.includes('fn_manager_dashboard_workspace')) throw Object.assign(new Error('Clinical unit is not accessible.'), { code: '42501' }); return { rows: [] }; };
 const res = response(); await handler(request({ unitId: '9' }), res); assert.equal(res.statusCode, 403);
});

test('Excel exports the same scoped snapshot as text-safe workbook cells', async () => {
 const snapshot = { generated_at:'2026-09-09T10:00:00', from:'2026-09-09', to:'2026-09-10', clinical_basis:'Current census', staffing_basis:'Roster',
 kpis:{patients:1}, patients:[{display_name:'=2+2'}], patient_total:1, by_unit:[], workload:[], schedule:[], alerts:[] };
 fake.query = async sql => sql.includes('fn_manager_dashboard_workspace') ? {rows:[{snapshot}]} : {rows:[]};
 const res = response(); await handler({...request({from:'2026-09-09',to:'2026-09-10'}),path:'/manager/workspace/excel'},res);
 assert.ok(Buffer.isBuffer(res.body));
 const ExcelJS = require('exceljs'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(res.body);
 assert.equal(workbook.getWorksheet('Patients (up to 500)').getCell('A2').value,'=2+2');
 assert.equal(res.headers['Cache-Control'],'no-store');
});
