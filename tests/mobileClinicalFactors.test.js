const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const fakePool = { query: async () => { throw new Error('Unexpected query'); } };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
const router = require('../routes/clinical');
const route = router.stack.find(l => l.route?.path === '/mobile/patients/:encounterId/factors' && l.route.methods.get).route;
const permission = route.stack[0].handle;
const handler = route.stack[1].handle;
const request = () => ({user:{sub:'271'},params:{encounterId:'2'},query:{userId:'999'},rid:'factor-test'});
const response = () => ({statusCode:200,headers:{},status(code){this.statusCode=code;return this;},set(k,v){this.headers[k]=v;return this;},json(body){this.body=body;return this;}});

test('factor choices require the mobile patient permission', async () => {
  fakePool.query = async (sql, values) => {
    assert.deepEqual(values,[271,'screen:mobile_clinical_patients:open']);
    return {rows:[{ok:false}]};
  };
  const res=response();
  await permission(request(),res,()=>assert.fail('Permission denied should stop'));
  assert.equal(res.statusCode,403);
});

test('invalid and inaccessible encounters cannot expose factor configuration', async () => {
  fakePool.query=async()=>assert.fail('Invalid ID reached the database');
  const invalid=response();
  await handler({...request(),params:{encounterId:'-1'}},invalid);
  assert.equal(invalid.statusCode,400);
  let calls=0;
  fakePool.query=async(sql,values)=>{calls++;assert.deepEqual(values,[271,2]);return {rows:[{allowed:false}]};};
  const denied=response();await handler(request(),denied);
  assert.equal(denied.statusCode,404);assert.equal(calls,1);
});

test('authorized factor choices use the current rule and are not cached', async () => {
  const factors=[{id:2,factor_name:'Complex base complexity'}];
  let calls=0;
  fakePool.query=async(sql,values)=>{
    if(++calls===1){assert.deepEqual(values,[271,2]);return {rows:[{allowed:true}]};}
    assert.deepEqual(values,[2]);
    assert.match(sql,/fn_clinical_active_rule_set/);
    assert.match(sql,/rsf\.is_active AND f\.is_active AND c\.is_active/);
    return {rows:factors};
  };
  const res=response();await handler(request(),res);
  assert.equal(res.statusCode,200);assert.deepEqual(res.body,factors);
  assert.equal(res.headers['Cache-Control'],'no-store');
});

test('missing current rule returns an actionable response', async () => {
  let calls=0;
  fakePool.query=async()=>{
    if(++calls===1)return {rows:[{allowed:true}]};
    throw Object.assign(new Error('No active acuity rule set applies to this encounter.'),{code:'P0001'});
  };
  const res=response();await handler(request(),res);
  assert.equal(res.statusCode,422);
  assert.equal(res.body.code,'CLINICAL_ACUITY_RULE_SET_REQUIRED');
  assert.match(res.body.error,/effective dates/);
});
