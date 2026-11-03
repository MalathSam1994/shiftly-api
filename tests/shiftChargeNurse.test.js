const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const pool = { query: async () => assert.fail('Unexpected database query') };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
const router = require('../routes/shiftAssignments');
const routeStack = router.stack.find(x => x.route?.path === '/:id/charge-nurse').route.stack;
const route = routeStack[routeStack.length-1].handle;
const mobile = require('../query/mobileDashboard').stack.find(x => x.route?.path === '/').route.stack[0].handle;
const response = () => ({ statusCode: 200, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; }, set() { return this; } });
const request = (body={is_charge_nurse:true}) => ({ user:{id:271},params:{id:'417'},body,query:{},rid:'charge-nurse-test' });

test('selection rejects invalid IDs and non-boolean input before querying', async () => {
 for (const body of [{}, {is_charge_nurse:'true'}, {is_charge_nurse:1}, {is_charge_nurse:null}]) {
  const res=response(); await route(request(body),res); assert.equal(res.statusCode,400);
 }
 const req=request(); req.params.id='417junk'; const res=response(); await route(req,res); assert.equal(res.statusCode,400);
});
test('selection requires authenticated actor', async () => {
 const req=request();req.user=null;const res=response();await route(req,res);assert.equal(res.statusCode,401);
});

test('selection middleware blocks users without the Shift Periods permission',async()=>{
 pool.query=async(sql,values)=>{ assert.match(sql,/fn_user_has_permission/);assert.deepEqual(values,[271,'screen:shift_periods:open']);return {rows:[{ok:false}]}; };
 const res=response();let next=false;await routeStack[0].handle(request(),res,()=>{next=true;});
 assert.equal(res.statusCode,403);assert.equal(next,false);
});

function fixture({scope=true,approved=false,edit=true}={}) {
 let writes=0;
 pool.query=async(sql,values)=>{
  if (/SELECT\s+sa.id/.test(sql)) return {rows:[{id:417,shift_period_id:12,division_id:1,department_id:38}]};
  if (/WITH actor/.test(sql)) { assert.deepEqual(values,[271,1,38]);return {rows:[{ok:scope}]}; }
  if (/SELECT sp.status/.test(sql)) return {rows:[{status:approved?'APPROVED':'DRAFT'}]};
  if (/fn_user_has_permission/.test(sql)) { assert.deepEqual(values,[271,'action:shift_periods:edit_approved_assignments']);return {rows:[{ok:edit}]}; }
  assert.match(sql,/set_shift_charge_nurse/);assert.deepEqual(values,[271,417,true]);writes++;
  return {rows:[{assignment:{id:417,is_charge_nurse:true,can_be_charge_nurse:true}}]};
 };
 return ()=>writes;
}
test('authorized selection calls one atomic SQL action',async()=>{
 const writes=fixture();const res=response();await route(request(),res);assert.equal(res.statusCode,200);assert.equal(res.body.is_charge_nurse,true);assert.equal(writes(),1);
});
test('scope denial blocks designation',async()=>{
 const writes=fixture({scope:false});const res=response();await route(request(),res);assert.equal(res.statusCode,403);assert.equal(writes(),0);
});
test('approved-period editing permission is enforced',async()=>{
 const writes=fixture({approved:true,edit:false});const res=response();await route(request(),res);assert.equal(res.statusCode,403);assert.equal(writes(),0);
});
test('mobile summary uses authenticated actor and exposes current charge context',async()=>{
 const current={shift_assignment_id:417,start_at:'2026-11-03T19:00:00+01:00',end_at:'2026-11-04T07:30:00+01:00'};
 let calls=0;
 pool.query=async(sql,values)=>{
  calls++;
  assert.equal(values[0],271);
  if (/fn_mobile_dashboard\(/.test(sql)) return {rows:[{user_id:271,managers:[]}]};
  if (/fn_mobile_current_charge_nurse_shift/.test(sql)) return {rows:[{published_patient_assignment_count:0,current_charge_nurse_shift:current}]};
  return {rows:[{user_id:271}]};
 };
 const req=request();req.query={userId:'999'};const res=response();await mobile(req,res);
 assert.equal(res.statusCode,200);assert.deepEqual(res.body.current_charge_nurse_shift,current);assert.equal(calls,3);
});
test('mobile summary requires authentication even when userId is supplied',async()=>{
 pool.query=async()=>assert.fail('Unauthenticated query');const req=request();req.user=null;req.query={userId:'271'};
 const res=response();await mobile(req,res);assert.equal(res.statusCode,401);
});
