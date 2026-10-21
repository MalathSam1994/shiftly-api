const assert=require('node:assert/strict');
const test=require('node:test');
const dbPath=require.resolve('../db');
const fake={query:async()=>{throw new Error('Unexpected query');}};
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:fake};
const router=require('../routes/clinical');
const route=(path,method='post')=>router.stack.find(l=>l.route?.path===path&&l.route.methods[method]).route;
const handler=(path,method='post')=>route(path,method).stack.at(-1).handle;
const req=(body={},params={})=>({body,params,query:{},user:{sub:'271'},rid:'mpi-test'});
const res=()=>({statusCode:200,headers:{},status(n){this.statusCode=n;return this;},set(k,v){this.headers[k]=v;return this;},json(body){this.body=body;return this;}});

test('merge and unmerge require distinct explicit permissions, including previews',async()=>{
 for(const [path,permission] of [
  ['/patients/:patientId/merge/preview','merge'],['/patients/:patientId/merge','merge'],
  ['/patient-merges/:eventId/unmerge/preview','unmerge'],['/patient-merges/:eventId/unmerge','unmerge']]){
  fake.query=async(sql,values)=>{assert.deepEqual(values,[271,'action:clinical_patient_identity:'+permission]);return {rows:[{ok:false}]};};
  const response=res();await route(path).stack[0].handle(req(),response,()=>assert.fail('Permission bypass'));
  assert.equal(response.statusCode,403);
 }
});
test('preview uses authenticated actor and selected files without writing clinical tables',async()=>{
 fake.query=async(sql,values)=>{assert.match(sql,/SELECT shiftly_api.fn_clinical_mpi_review/);assert.deepEqual(values,[271,42,43,null]);return {rows:[{result:{review_key:'fresh',can_apply:true}}]};};
 const response=res();await handler('/patients/:patientId/merge/preview')(req({target_patient_id:43,actor:999},{patientId:'42'}),response);
 assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.body.review_key,'fresh');
});
test('apply sends reviewed identifiers and reason to one atomic DB operation',async()=>{
 fake.query=async(sql,values)=>{assert.match(sql,/SELECT shiftly_api.fn_clinical_mpi_apply/);assert.deepEqual(values,[271,42,43,'fresh','Verified matching documents',null]);return {rows:[{result:{event_id:10,canonical_patient_id:43}}]};};
 const response=res();await handler('/patients/:patientId/merge')(req({target_patient_id:43,review_key:'fresh',reason:'Verified matching documents',patient_public_id:'DO-NOT-REWRITE',encounter_id:888},{patientId:'42'}),response);
 assert.equal(response.body.canonical_patient_id,43);
});
test('unmerge uses immutable audit event identity, not client supplied member lists',async()=>{
 fake.query=async(sql,values)=>{assert.deepEqual(values,[271,null,null,'fresh','Verified distinct patients',10]);return {rows:[{result:{event_type:'UNMERGE'}}]};};
 const response=res();await handler('/patient-merges/:eventId/unmerge')(req({target_patient_id:999,review_key:'fresh',reason:'Verified distinct patients',members:[999]},{eventId:'10'}),response);
 assert.equal(response.body.event_type,'UNMERGE');
});
test('invalid merge inputs never reach the database',async()=>{
 fake.query=async()=>assert.fail('Invalid input reached database');
 for(const [body,params] of [[{target_patient_id:43,reason:'Verified patient'},{patientId:'42'}],
  [{target_patient_id:43,review_key:'fresh',reason:'short'},{patientId:'42'}],
  [{target_patient_id:-1,review_key:'fresh',reason:'Verified patient'},{patientId:'42'}],
  [{target_patient_id:43,review_key:'fresh',reason:'Verified patient'},{patientId:'bad'}]]){
  const response=res();await handler('/patients/:patientId/merge')(req(body,params),response);assert.equal(response.statusCode,400);
 }
});
test('stale, dependent, linked and active-encounter conflicts remain actionable',async()=>{
 for(const hint of ['IDENTITY_REVIEW_STALE','IDENTITY_MERGE_BLOCKED','IDENTITY_ALREADY_LINKED','IDENTITY_MERGE_DEPENDENCY','IDENTITY_USE_CANONICAL']){
  fake.query=async()=>{throw Object.assign(new Error('Do not leak patient details'),{code:'P0001',hint});};
  const response=res();await handler('/patients/:patientId/merge')(req({target_patient_id:43,review_key:'fresh',reason:'Verified patient identity'},{patientId:'42'}),response);
  assert.equal(response.statusCode,409);assert.equal(response.body.code,hint);assert.doesNotMatch(response.body.error,/leak/);
 }
});
test('MPI and namespaced resolution use scope functions and do not cache identities',async()=>{
 fake.query=async(sql,values)=>{assert.match(sql,/fn_clinical_patient_mpi/);assert.deepEqual(values,[271,42]);return {rows:[{result:{members:[{patient_id:42}],empi_id:'example'}}]};};
 const detail=res();await handler('/patients/:patientId/mpi','get')(req({}, {patientId:'42'}),detail);
 assert.equal(detail.headers['Cache-Control'],'no-store');assert.equal(detail.body.members.length,1);
 fake.query=async(sql,values)=>{assert.match(sql,/fn_clinical_mpi_resolve/);assert.deepEqual(values,[271,'SOURCE:HOSPITAL-A','0000123']);return {rows:[{result:null}]};};
 const missing=res();await handler('/patient-identities/resolve')(req({authority:'SOURCE:HOSPITAL-A',identifier:'0000123'}),missing);
 assert.equal(missing.statusCode,404);assert.equal(missing.headers['Cache-Control'],'no-store');
});
test('new registrations cannot simulate a merge by choosing a status',async()=>{
 fake.query=async()=>assert.fail('Status-only merge reached database');
 const response=res();await handler('/patients')(req({display_name:'Example',patient_status:'MERGED'}),response);
 assert.equal(response.statusCode,409);assert.equal(response.body.code,'IDENTITY_REVIEW_REQUIRED');
});
