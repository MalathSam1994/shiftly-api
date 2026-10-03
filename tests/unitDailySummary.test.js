const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read}=require('../reports/clinicalHandover/unitSummary');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:38,unitId:1,shiftDate:'2026-09-23'};
test('daily summary generates without any approved shift selection',()=>{
  const p=registry.parameters(registry.report('unit_handover_summary'),input);
  assert.equal(p.shiftDate,input.shiftDate);
  assert.equal(p.shiftContextId,undefined);
  for(const key of ['divisionId','departmentId','unitId','shiftDate']) {
    const missing={...input};delete missing[key];
    assert.throws(()=>registry.parameters(registry.report('unit_handover_summary'),missing));
  }
});
test('removed shift and range parameters cannot silently alter a daily report',()=>{
  for(const key of ['shiftTypeId','shiftContextId','incomingContextId','outgoingContextId','fromDate','toDate']) {
    assert.throws(()=>registry.parameters(registry.report('unit_handover_summary'),{...input,[key]:1}),/not supported/);
  }
  assert.throws(()=>registry.parameters(registry.report('workload_and_continuity'),input),/required/);
});
test('daily Excel stays compact and preserves every patient and exact assessment time',async()=>{
  const value={unitContext:{version:2,date:'2026-09-23',completeDay:true,basis:'HISTORICAL'},
    dailySummary:{patients:2},totals:{patients:2},notes:['One location record is missing.'],
    overview:[{measure:'Patients',value:2}],patients:[
      {patientName:'=SUM(1,2)',encounter:'00001',location:'A / 1',clinicalStatus:'WATCH',acuity:'High',assessedAt:'2026-09-23T18:30:00+02:00'},
      {patientName:'Patient Two',encounter:'00002',location:'A / 2',clinicalStatus:null,acuity:null,assessedAt:null}]};
  const result=await read({query:async(sql,args)=>{assert.equal(args[0],271);assert.deepEqual(args[1],input);return {rows:[{value}]};}},{actor:271,parameters:input});
  assert.equal(result.sections.reduce((n,s)=>n+s.total,0),3);
  const bytes=await excel({...result,reportId:'unit_handover_summary',generatedAt:'2026-09-30T12:00:00+02:00',scopeLabel:'ICU',businessTimezone:'Europe/Berlin'});
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Patients']);
  const patients=book.getWorksheet('Patients');
  assert.equal(patients.rowCount,3);
  assert.equal(patients.getCell('B2').value,'=SUM(1,2)');
  assert.equal(patients.getCell('B2').type,ExcelJS.ValueType.String);
  assert.equal(patients.getCell('C2').value,'00001');
  assert.equal(patients.getCell('F2').value,'2026-09-23T18:30:00+02:00');
  assert.equal(patients.getCell('F3').value,'Not recorded');
});

test('old saved boundary exports remain complete while new exports require the daily sections',()=>{
  const dbPath=require.resolve('../db');const previous=require.cache[dbPath];
  require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{}};
  const {exportData}=require('../reports/clinicalHandover/service');
  if(previous)require.cache[dbPath]=previous;else delete require.cache[dbPath];
  const section=id=>({id,grain:'record',evidenceBasis:'HISTORICAL',availability:'AVAILABLE',limitations:[],columns:[],rows:[],total:0});
  const saved={reportId:'unit_handover_summary',rowGrain:'encounter',summaries:[],metricDefinitions:[],sourceLimitations:[],totals:{},rowCount:0,
    authorizedScope:{private:true},sections:['overview','distributions','exceptions','patients','movements'].map(section)};
  assert.equal(exportData(saved).authorizedScope,undefined);
  assert.throws(()=>exportData({...saved,sections:saved.sections.slice(0,-1)}),/Every declared section/);
  const daily={...saved,unitContext:{version:2},sections:['overview','patients'].map(section)};
  assert.equal(exportData(daily).rowCount,0);
  assert.throws(()=>exportData({...daily,sections:[section('overview')]}),/Every declared section/);
});
