const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const fake = {query: async()=>{throw new Error('Unexpected query');}, connect:async()=>({
  query:(...args)=>fake.query(...args), release:()=>{},
})};
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:fake};
const router=require('../routes/clinical');
const route=(path,method='post')=>router.stack.find(l=>l.route?.path===path&&l.route.methods[method]).route;
const handler=(path,method='post')=>route(path,method).stack.at(-1).handle;
const req=(body={},params={})=>({body,params,query:{},user:{sub:'271'},rid:'identity-test'});
const res=()=>({statusCode:200,headers:{},status(n){this.statusCode=n;return this;},set(k,v){this.headers[k]=v;return this;},json(body){this.body=body;return this;}});
const noMatches={matches:[],has_more:false,review_key:'empty'};
const match={matches:[{patient_id:42,patient_public_id:'OLD-MRN'}],has_more:false,review_key:'review-v1'};
const patient={display_name:'Identity Regression',date_of_birth:'1981-03-04'};
const reset=(callback)=>{fake.query=callback;};

test('identity search requires existing screen permission',async()=>{
  reset(async(sql,values)=>{assert.deepEqual(values,[271,'screen:clinical_patient_administration:open']);return {rows:[{ok:false}]};});
  const response=res();await route('/patients/search').stack[0].handle(req({query:'Smith'}),response,()=>assert.fail('permission bypass'));
  assert.equal(response.statusCode,403);
});
test('scoped search uses authenticated actor, POST payload and no-store',async()=>{
  reset(async(sql,values)=>{assert.deepEqual(values,[271,JSON.stringify({query:'0000125'}),true]);return {rows:[{result:noMatches}]};});
  const response=res();await handler('/patients/search')(req({query:'0000125',actor:999}),response);
  assert.equal(response.headers['Cache-Control'],'no-store');assert.deepEqual(response.body,noMatches);
});
test('automatic registration omits both business numbers and retains encounter foreign key',async()=>{
  const inserts=[];
  reset(async(sql,values)=>{
    if(sql.includes('identity_candidates'))return {rows:[{result:noMatches}]};
    if(sql.includes('FROM shiftly_schema.clinical_units'))return {rows:[{id:2,division_id:1,department_id:39}]};
    if(sql.trimStart().startsWith('INSERT')) {
      inserts.push({sql,values});
      if(sql.includes('clinical_patients')){assert.doesNotMatch(sql,/patient_public_id/);return {rows:[{id:42,patient_public_id:'MRN-00000042'}]};}
      assert.doesNotMatch(sql,/encounter_number/);assert.ok(values.includes(42));return {rows:[{id:200,patient_id:42,encounter_number:'ENC-0200'}]};
    }
    return {rows:[]};
  });
  const response=res();await handler('/patients')(req({...patient,encounter:{clinical_unit_id:2}}),response);
  assert.equal(response.statusCode,201);assert.equal(inserts.length,2);assert.equal(response.body.encounter.patient_id,response.body.patient.id);
});
test('duplicate review and stale confirmations cannot write a new patient',async()=>{
  for(const extra of [{},{match_review_key:'old',match_review_reason:'Verified different person'}]){
    const calls=[];reset(async(sql)=>{calls.push(sql);return {rows:sql.includes('identity_candidates')?[{result:match}]:[]};});
    const response=res();await handler('/patients')(req({...patient,...extra}),response);
    assert.equal(response.statusCode,409);assert.equal(response.body.code,'PATIENT_MATCH_REVIEW_REQUIRED');
    assert.equal(response.body.matches[0].patient_id,42);assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.some(s=>s.startsWith('INSERT')));
  }
});
test('separate-patient review is recorded in the same transaction',async()=>{
  const calls=[];reset(async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes('identity_candidates'))return {rows:[{result:match}]};
    if(sql.trimStart().startsWith('INSERT INTO shiftly_schema.clinical_patients'))return {rows:[{id:43,patient_public_id:'MRN-43'}]};
    return {rows:[]};
  });
  const response=res();await handler('/patients')(req({...patient,match_review_key:'review-v1',match_review_reason:'Verified different person'}),response);
  assert.equal(response.statusCode,201);
  const audit=calls.find(c=>c.sql.includes('INSERT INTO shiftly_schema.clinical_patient_registration_reviews'));
  assert.deepEqual(audit.values,[43,271,'[42]','Verified different person']);assert.equal(calls.at(-1).sql,'COMMIT');
});
test('ordinary edit cannot change MRN; old-client unchanged MRN is accepted without clearing new fields',async()=>{
  const writes=[];reset(async(sql,values)=>{
    if(sql.startsWith('SELECT id,'))return {rows:[{id:42,patient_public_id:'00042',patient_status:'ACTIVE'}]};
    writes.push(sql);assert.doesNotMatch(sql,/first_name|identity_document|phone|patient_public_id/);return {rows:[{id:42}]};
  });
  const rejected=res();await handler('/patients/:patientId','put')(req({patient_public_id:'different'},{patientId:'42'}),rejected);
  assert.equal(rejected.body.code,'MRN_CORRECTION_REQUIRED');assert.equal(writes.length,0);
  const accepted=res();await handler('/patients/:patientId','put')(req({patient_public_id:'00042',display_name:'Corrected Name'},{patientId:'42'}),accepted);
  assert.equal(accepted.statusCode,200);assert.equal(writes.length,1);
});
test('new encounter uses existing patient and rejects inaccessible or merged patients',async()=>{
  for(const accessible of [null,{id:42,patient_status:'MERGED'},{id:42,patient_status:'ACTIVE'}]){
    let writes=0;reset(async(sql,values)=>{
      if(sql.includes('FROM shiftly_schema.clinical_units'))return {rows:[{id:2,division_id:1,department_id:39}]};
      if(sql.startsWith('SELECT id,'))return {rows:accessible?[accessible]:[]};
      if(sql.trimStart().startsWith('INSERT')){writes++;assert.match(sql,/clinical_encounters/);assert.ok(values.includes(42));return {rows:[{id:201,patient_id:42}]};}
      throw new Error('Unexpected query');
    });
    const response=res();await handler('/patients/:patientId/encounters')(req({clinical_unit_id:2},{patientId:'42'}),response);
    assert.equal(response.statusCode,accessible?.patient_status==='ACTIVE'?201:accessible?409:404);
    assert.equal(writes,accessible?.patient_status==='ACTIVE'?1:0);
  }
});
test('second active encounter gives an actionable conflict',async()=>{
  reset(async(sql)=>{
    if(sql.includes('FROM shiftly_schema.clinical_units'))return {rows:[{id:2,division_id:1,department_id:39}]};
    if(sql.startsWith('SELECT id,'))return {rows:[{id:42,patient_status:'ACTIVE'}]};
    throw Object.assign(new Error('duplicate'),{code:'23505',table:'clinical_encounters',constraint:'ux_clinical_encounters_active_patient'});
  });
  const response=res();await handler('/patients/:patientId/encounters')(req({clinical_unit_id:2},{patientId:'42'}),response);
  assert.equal(response.statusCode,409);assert.equal(response.body.code,'ACTIVE_ENCOUNTER_EXISTS');
});
test('MRN correction requires dedicated permission and a reason',async()=>{
  reset(async(sql,values)=>{assert.deepEqual(values,[271,'action:clinical_patient_identity:correct']);return {rows:[{ok:false}]};});
  const denied=res();await route('/patients/:patientId/mrn-correction').stack[0].handle(req({}, {patientId:'42'}),denied,()=>assert.fail('permission bypass'));
  assert.equal(denied.statusCode,403);
  reset(async()=>assert.fail('Invalid reason queried database'));
  const invalid=res();await handler('/patients/:patientId/mrn-correction')(req({patient_public_id:'NEW',reason:'short'},{patientId:'42'}),invalid);
  assert.equal(invalid.statusCode,400);
});
test('registration rejects invalid identity data before any write',async()=>{
  reset(async()=>assert.fail('Invalid input queried database'));
  for(const input of [{first_name:'x'.repeat(81)},{identity_document_number:'ID123'},{date_of_birth:'2025-02-30'}]){
    const response=res();await handler('/patients')(req({...patient,...input}),response);
    assert.equal(response.statusCode,400);
  }
});

