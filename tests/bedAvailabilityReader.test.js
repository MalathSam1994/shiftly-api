const test=require('node:test');
const assert=require('node:assert/strict');
const {read,lookupUnits}=require('../reports/clinicalHandover/bedAvailability');
const reference='2026-10-24T21:30:00+02:00';
const row={unitId:1,division:'Hospital',department:'Medicine',unit:'Ward',totalBeds:12,occupiedBeds:9,
 availableBeds:3,availableBedsUpperBound:3,availabilityKind:'CONFIRMED',activePatients:9,unknownBeds:0,availabilityStatus:'Available'};
const defaultTotals={units:1,totalBeds:12,occupiedBeds:9,availableBeds:3,availableBedsUpperBound:3,availabilityKind:'CONFIRMED',
 knownUnits:1,unavailableUnits:0,estimatedUnits:0,missingCapacityUnits:0,activePatients:9,unknownBeds:0};
function source(units=[row],totals=defaultTotals) {
 return {context:{version:2,reference,basis:'CURRENT'},units,totals,notes:['Configured capacity; physical readiness is not recorded.']};
}
async function adapt(value,parameters={}) {
 let calls=0;
 const result=await read({query:async(sql,args)=>{
  calls++;assert.equal(sql,'SELECT shiftly_api.fn_handover_available_beds_by_unit($1::integer,$2::jsonb) value');
  assert.deepEqual(args,[271,parameters]);return {rows:[{value}]};
 }},{actor:271,parameters});
 assert.equal(calls,1);return result;
}
test('available beds reader uses one actor-bound query and preserves SQL totals, scope rows and snapshot time',async()=>{
 const d=source(),result=await adapt(d,{divisionId:1});
 assert.equal(result.totals,d.totals);assert.equal(result.bedAvailabilityContext,d.context);
 assert.deepEqual(result.sections.map(s=>s.id),['units']);
 assert.equal(result.sections[0].rows,d.units);assert.equal(result.sections[0].total,1);
 assert.equal(result.sections[0].evidenceBasis,'CURRENT');assert.deepEqual(result.sourceLimitations,d.notes);
 assert.deepEqual(result.sections[0].columns.map(c=>c.key),['division','department','unit','totalBeds','occupiedBeds','unknownBeds','availableBeds','availabilityStatus']);
 assert.equal(result.sections[0].columns.find(c=>c.key==='occupiedBeds').label,'Recorded occupied beds');
 assert.equal(result.sections[0].columns.find(c=>c.key==='unknownBeds').label,'Patients without a recorded bed');
 assert.ok(result.sections[0].columns.filter(c=>c.key.endsWith('Beds')).every(c=>c.type==='number'));
 assert.equal(result.summaries[1].label,'Available beds');assert.equal(result.summaries[1].value,3);
});
test('missing capacity keeps both totals null and cannot become a misleading zero or a partial total',async()=>{
 const d=source([{...row,totalBeds:null,availableBeds:null,availableBedsUpperBound:null,availabilityKind:'CAPACITY_NOT_CONFIGURED',availabilityStatus:'Capacity not configured'},row],
  {...defaultTotals,units:2,totalBeds:null,occupiedBeds:18,availableBeds:null,availableBedsUpperBound:null,availabilityKind:'CAPACITY_NOT_CONFIGURED',
   knownUnits:1,unavailableUnits:1,missingCapacityUnits:1,activePatients:18});
 const result=await adapt(d);
 assert.equal(result.summaries[1].label,'Capacity not configured');
 assert.equal(result.summaries[1].value,null);assert.equal(result.summaries[1].availability,'UNAVAILABLE');
 assert.match(result.summaries[1].definition,/neither total confirmed availability nor an overall upper bound/);
 assert.equal(result.sections[0].rows[0].availableBeds,null);assert.equal(result.sections[0].rows[1].availableBeds,3);
});
test('incomplete bed labels expose the SQL upper bound with an explicit qualification and no patient-count arithmetic',async()=>{
 const estimated={...row,totalBeds:18,occupiedBeds:3,unknownBeds:11,activePatients:14,availableBeds:null,
  availableBedsUpperBound:15,availabilityKind:'UPPER_BOUND',availabilityStatus:'Needs verification'};
 const totals={...defaultTotals,totalBeds:18,occupiedBeds:3,unknownBeds:11,activePatients:14,availableBeds:null,
  availableBedsUpperBound:15,availabilityKind:'UPPER_BOUND',knownUnits:0,unavailableUnits:1,estimatedUnits:1};
 const result=await adapt(source([estimated],totals));
 assert.equal(result.totals,totals);assert.equal(result.sections[0].rows[0],estimated);
 assert.equal(result.sections[0].rows[0].availableBeds,null);
 assert.equal(result.summaries[1].label,'Available beds upper bound');assert.equal(result.summaries[1].value,15);
 assert.equal(result.summaries[1].availability,'AVAILABLE');assert.match(result.summaries[1].definition,/Needs verification/);
});
test('an upper bound of zero stays an estimate rather than becoming confirmed zero',async()=>{
 const result=await adapt(source([{...row,availableBeds:null,availableBedsUpperBound:0,availabilityKind:'UPPER_BOUND',unknownBeds:1}],
  {...defaultTotals,availableBeds:null,availableBedsUpperBound:0,availabilityKind:'UPPER_BOUND',unknownBeds:1,knownUnits:0,unavailableUnits:1,estimatedUnits:1}));
 assert.equal(result.summaries[1].label,'Available beds upper bound');assert.equal(result.summaries[1].value,0);
 assert.equal(result.sections[0].rows[0].availableBeds,null);
});
test('empty authorized unit results preserve numeric zero and an available empty section',async()=>{
 const result=await adapt(source([],{units:0,totalBeds:0,occupiedBeds:0,availableBeds:0,availableBedsUpperBound:0,availabilityKind:'CONFIRMED',
  knownUnits:0,unavailableUnits:0,estimatedUnits:0,missingCapacityUnits:0,activePatients:0,unknownBeds:0}));
 assert.equal(result.sections[0].total,0);assert.deepEqual(result.sections[0].rows,[]);
 assert.equal(result.sections[0].availability,'AVAILABLE');
 assert.deepEqual(result.summaries.map(s=>[s.value,s.availability]),[[0,'AVAILABLE'],[0,'AVAILABLE'],[0,'AVAILABLE']]);
});
test('old database report versions require the update instead of recalculating missing fields in JavaScript',async()=>{
 for(const version of [1,undefined]) {
  const d=source();d.context={...d.context,version};
  await assert.rejects(adapt(d),error=>error.code==='REPORT_UPDATE_REQUIRED'&&error.status===409&&/database update/.test(error.message));
 }
});
test('database authorization errors are propagated without a fallback dataset',async()=>{
 const error=Object.assign(new Error('No authorized organization matches these report parameters.'),{code:'42501'});
 await assert.rejects(read({query:async()=>{throw error;}},{actor:0,parameters:{}}),e=>e===error);
});
test('active-unit lookup preserves exact selection, search, paging and complete parent metadata in one query',async()=>{
 const value={rows:[{value:1,label:'Ward | Medicine | Hospital',meta:{unitId:1,divisionId:2,departmentId:3,
  divisionIdLabel:'Hospital',departmentIdLabel:'Medicine'}}],total:1,offset:0,limit:50,business_timezone:'Europe/Berlin'};
 const parameters={divisionId:2,departmentId:3};
 let calls=0;
 const result=await lookupUnits({query:async(sql,args)=>{
  calls++;assert.match(sql,/^-- available_beds_by_unit: active unit lookup/);
  assert.match(sql,/fn_handover_report_scope\(\$1::integer,\$2::jsonb\)/);
  assert.deepEqual(args,[271,parameters,'Ward',0,'1']);return {rows:[{value}]};
 }},{actor:271,parameters,search:'Ward',offset:0,value:'1'});
 assert.equal(calls,1);assert.equal(result,value);
});
test('active-unit lookup rejects oversized searches and invalid page offsets before querying',async()=>{
 const client={query:async()=>assert.fail('Invalid lookup input must not reach PostgreSQL')};
 for(const invalid of [{search:'x'.repeat(121)},{search:1},{offset:-1},{offset:10001},{offset:1.5}])
  await assert.rejects(lookupUnits(client,{actor:271,...invalid}),error=>error.code==='REPORT_VALIDATION'&&error.status===400);
});
