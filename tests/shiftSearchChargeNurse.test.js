const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const pool = { query: async () => assert.fail('Unexpected database query') };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
const router = require('../query/desktopShiftMatrixSearch');
const route = router.stack.find(x => x.route?.path === '/').route.stack[0].handle;
const response = () => ({ statusCode: 200, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; } });

test('general shift search joins charge information only to authorized assignment IDs', async () => {
 const records=[{shift_assignment_id:1,user_id:9,is_charge_nurse:true,can_be_charge_nurse:true},
  {shift_assignment_id:2,user_id:9,is_charge_nurse:false,can_be_charge_nurse:true}];
 pool.query=async(sql,values)=>{
  assert.match(sql,/FROM shiftly_api\.fn_desktop_shift_matrix_search/);
  assert.match(sql,/LEFT JOIN shiftly_schema\.shift_assignments sa\s+ON sa.id = scoped.shift_assignment_id\s+AND sa.user_id = scoped.user_id/);
  assert.match(sql,/sa.is_charge_nurse/);
  assert.match(sql,/fn_shift_assignment_can_be_charge\(sa.id\)/);
  assert.deepEqual(values,[271,'2026-11-01','2026-12-01',1,38,1,2,9,'APPROVED']);
  return {rows:records};
 };
 const req={user:{sub:271},query:{loggedUserId:'999',from:'2026-11-01',to:'2026-12-01',divisionId:'1',departmentId:'38',staffTypeId:'1',shiftTypeId:'2',userId:'9',status:'APPROVED'}};
 const res=response();await route(req,res);
 assert.equal(res.statusCode,200);assert.deepEqual(res.body,records);
});

test('loggedUserId alone cannot grant general search scope',async()=>{
 pool.query=async()=>assert.fail('Unauthenticated request reached database');
 const res=response();await route({query:{loggedUserId:'271',from:'2026-11-01',to:'2026-12-01'}},res);
 assert.equal(res.statusCode,400);
});
