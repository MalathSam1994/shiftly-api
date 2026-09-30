const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read,pageDetails}=require('../reports/clinicalHandover/patientSheet');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:38,unitId:1,shiftDate:'2026-09-23'};
const definition=registry.report('patient_handover_sheet');

test('patient sheet requires exactly the four daily fields, with no shift selectors',()=>{
  assert.deepEqual(definition.parameters,Object.keys(input));
  assert.deepEqual(definition.required,Object.keys(input));
  assert.equal(definition.timeBasis,'DAY_SNAPSHOT');
  assert.deepEqual(definition.sortingOptions,['location']);
  assert.equal(registry.parameters(definition,input).shiftDate,input.shiftDate);
  for(const key of Object.keys(input)) {
    const missing={...input};delete missing[key];
    assert.throws(()=>registry.parameters(definition,missing));
  }
  for(const key of ['shiftTypeId','shiftContextId','outgoingContextId','incomingContextId','fromDate','toDate','room','bed',
    'encounterIds','incomingStaffId','outgoingStaffId','acuityLevelId','clinicalStatus']) {
    assert.throws(()=>registry.parameters(definition,{...input,[key]:1}),/not supported/);
  }
  assert.throws(()=>registry.parameters(registry.report('incoming_shift_readiness'),input),/required/);
});

function raw() {
  return {patientContext:{version:2,date:'2026-09-23',completeDay:true,basis:'HISTORICAL'},totals:{patients:2,factors:2},notes:[],
    patients:[{encounterId:'1',patientName:'=SUM(1,2)',patientId:'00001',encounter:'00002',location:'A / 1',clinicalStatus:'WATCH',
      summary:'Recorded condition',acuity:'High',assessedAt:'2026-09-23T18:30:00+02:00'},
      {encounterId:'2',patientName:'Patient Two',patientId:'00003',encounter:'00004',location:null,clinicalStatus:null,summary:null,acuity:null,assessedAt:null}],
    factors:[{encounterId:'1',patientId:'00001',patientName:'=SUM(1,2)',encounter:'00002',factor:'Care factor',value:0,notes:'Keep the recorded zero'},
      {encounterId:'2',patientId:'00003',patientName:'Patient Two',encounter:'00004',factor:'Second factor',value:2.5,notes:'ملاحظة'}]};
}
async function dataset() {
  const result=await read({query:async(sql,args)=>{
    assert.match(sql,/fn_handover_patient_daily_sheet/);assert.deepEqual(args,[271,input]);return {rows:[{value:raw()}]};
  }},{actor:271,parameters:input});
  return {...result,reportId:'patient_handover_sheet',title:definition.title,generatedAt:'2026-10-01T00:30:00+02:00',
    scopeLabel:'ICU',businessTimezone:'Europe/Berlin',rowCount:4};
}
test('daily adapter and paged patient detail preserve complete factors and separate encounters',async()=>{
  const data=await dataset();
  assert.deepEqual(data.sections.map(s=>s.id),['patients','factors']);
  assert.deepEqual(data.metricDefinitions,[]);
  assert.deepEqual(Object.keys(pageDetails(data,1,1)),['2']);
  assert.deepEqual(pageDetails(data,1,1)['2'].factors,[raw().factors[1]]);
});
test('compact Excel retains identities, zero values, notes and explicit timestamp offsets',async()=>{
  const bytes=await excel(await dataset());
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Patients','Care factors']);
  const patients=book.getWorksheet('Patients'),factors=book.getWorksheet('Care factors');
  assert.equal(patients.rowCount,3);assert.equal(factors.rowCount,3);
  assert.equal(patients.getCell('B2').value,'=SUM(1,2)');assert.equal(patients.getCell('B2').type,ExcelJS.ValueType.String);
  assert.equal(patients.getCell('C2').value,'00001');assert.equal(patients.getCell('D2').value,'00002');
  assert.equal(patients.getCell('H2').value,'2026-09-23T18:30:00+02:00');
  assert.equal(patients.getCell('H3').value,'Not recorded');
  assert.equal(factors.getCell('E2').value,0);assert.equal(factors.getCell('F3').value,'ملاحظة');
});
test('empty exports describe missing records without claiming an absence of care needs',async()=>{
  const data=await dataset();data.totals={patients:0,factors:0};
  data.sections=data.sections.map(s=>({...s,rows:[],total:0}));data.rowCount=0;
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(data));
  assert.equal(book.getWorksheet('Patients').getCell('A2').value,'No patients with a recorded unit location at this time.');
  assert.equal(book.getWorksheet('Care factors').getCell('A2').value,'No active care factors recorded.');
});
test('saved boundary reports keep their four-section contract; daily reports require both compact sections',async()=>{
  const dbPath=require.resolve('../db'),previous=require.cache[dbPath];
  require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{}};
  const {exportData}=require('../reports/clinicalHandover/service');
  if(previous)require.cache[dbPath]=previous;else delete require.cache[dbPath];
  const data=await dataset();
  assert.equal(exportData({...data,authorizedScope:{private:true}}).authorizedScope,undefined);
  assert.throws(()=>exportData({...data,sections:data.sections.slice(0,1)}),/Every declared section/);
  const legacy={...data,patientContext:{boundary:'2026-09-23T19:00:00+02:00'},rowCount:0,
    sections:['patients','factors','events','issues'].map(id=>({id,grain:'record',evidenceBasis:'HISTORICAL',availability:'AVAILABLE',limitations:[],columns:[],rows:[],total:0}))};
  assert.equal(exportData(legacy).rowCount,0);
  assert.throws(()=>exportData({...legacy,sections:legacy.sections.slice(0,-1)}),/Every declared section/);
});
