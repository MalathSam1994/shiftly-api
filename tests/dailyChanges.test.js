const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read,pageDetails}=require('../reports/clinicalHandover/shiftChanges');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:38,unitId:1,shiftDate:'2026-09-23'};
const definition=registry.report('changes_since_previous_shift');
test('daily changes has four required filters and rejects the old range, exact-time and detail filters',()=>{
  assert.equal(definition.title,'Daily changes');
  assert.deepEqual(definition.parameters,Object.keys(input));assert.deepEqual(definition.required,Object.keys(input));
  assert.deepEqual(definition.sortingOptions,['effectiveTime']);
  assert.deepEqual(registry.parameters(definition,input),{...input,groupBy:'timeline',sortBy:'effectiveTime'});
  for(const key of Object.keys(input)) {const missing={...input};delete missing[key];assert.throws(()=>registry.parameters(definition,missing));}
  for(const key of ['intervalMode','fromDate','toDate','fromTime','toTime','changeCategory','encounterId','actorId','shiftTypeId','shiftContextId','outgoingContextId']) {
    assert.throws(()=>registry.parameters(definition,{...input,[key]:1}),/not supported/);
  }
  assert.throws(()=>registry.parameters(definition,{...input,sortBy:'recordedTime'}));
  assert.throws(()=>registry.parameters(registry.report('handover_review_follow_up'),{divisionId:1,departmentId:39,unitId:2}),/required/);
});
async function dataset() {
  const value={clinicalStatusHidden:true,changeContext:{version:2,date:'2026-09-23',start:'2026-09-23T00:00:00+02:00',endExclusive:'2026-09-24T00:00:00+02:00',completeDay:true,basis:'HISTORICAL'},
    totals:{changes:2,changedEncounters:1},notes:['One conditional note.'],scopePairs:[{division_id:1,department_id:39}],
    changes:[{changeId:'c1',encounterId:'1',patientName:'=SUM(1,2)',patientId:'00001',encounter:'00002',effectiveAt:'2026-09-23T12:14:00+02:00',
      change:'Acuity',before:'Not recorded',after:'High',notes:null},
    {changeId:'c2',encounterId:'1',patientName:'=SUM(1,2)',patientId:'00001',encounter:'00002',effectiveAt:'2026-09-23T13:15:00+02:00',
      change:'Care factor - value',before:'0',after:'2.5',notes:'ملاحظة'}]};
  const data=await read({query:async(sql,args)=>{assert.match(sql,/fn_handover_daily_changes/);assert.deepEqual(args,[271,input]);return {rows:[{value}]};}},{actor:271,parameters:input});
  return {...data,reportId:definition.id,title:definition.title,generatedAt:'2026-10-01T01:30:00+02:00',businessTimezone:'Europe/Berlin',scopeLabel:'ICU',rowCount:2};
}
test('adapter keeps one complete timeline, SQL totals and private counterpart scope for service rechecks',async()=>{
  const data=await dataset();assert.deepEqual(data.sections.map(s=>s.id),['changes']);
  assert.deepEqual(data.totals,{changes:2,changedEncounters:1});assert.deepEqual(data.metricDefinitions,[]);
  assert.deepEqual(data.authorizationPairs,[{division_id:1,department_id:39}]);
  assert.ok(!data.sections[0].columns.some(c=>['changeId','source','actorId'].includes(c.key)));
});
test('two-sheet Excel keeps all before/after values, leading zeros, text-like formulas, notes and offset times',async()=>{
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(await dataset()));
  assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Changes']);
  const sheet=book.getWorksheet('Changes');assert.equal(sheet.rowCount,3);
  assert.equal(sheet.getCell('A2').value,'2026-09-23T12:14:00+02:00');
  assert.equal(sheet.getCell('B2').value,'=SUM(1,2)');assert.equal(sheet.getCell('B2').type,ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('C2').value,'00001');assert.equal(sheet.getCell('D2').value,'00002');
  assert.equal(sheet.getCell('F2').value,'Not recorded');assert.equal(sheet.getCell('F3').value,'0');
  assert.equal(sheet.getCell('G3').value,'2.5');assert.equal(sheet.getCell('H3').value,'ملاحظة');
});
test('empty Excel describes no recorded changes without claiming no changes occurred',async()=>{
  const data=await dataset();data.sections[0].rows=[];data.sections[0].total=0;data.totals={changes:0,changedEncounters:0};data.rowCount=0;
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(data));
  assert.equal(book.getWorksheet('Changes').getCell('A2').value,'No recorded changes for this unit during the selected date.');
});
test('legacy saved datasets require regeneration and keep stored detail unmodified',async()=>{
  const dbPath=require.resolve('../db'),previous=require.cache[dbPath];require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{}};
  const {exportData}=require('../reports/clinicalHandover/service');
  if(previous)require.cache[dbPath]=previous;else delete require.cache[dbPath];
  const daily=await dataset();assert.equal(exportData(daily).rowCount,2);
  assert.throws(()=>exportData({...daily,sections:[]}),/Every declared section/);
  const legacy={...daily,clinicalStatusHidden:false,changeContext:{start:'2026-09-23T00:00:00+02:00'},rowCount:2,sections:[
    {...daily.sections[0],rows:[{changeId:'c1'}],total:1},
    {...daily.sections[0],id:'fields',rows:[{changeId:'c1',field:'summary'}],total:1}]};
  assert.throws(()=>exportData({...legacy,authorizedScope:{private:true}}),/layout has changed/);
  assert.throws(()=>exportData({...legacy,sections:legacy.sections.slice(0,1)}),/layout has changed/);
  assert.deepEqual(pageDetails(legacy,0,1),{c1:[{changeId:'c1',field:'summary'}]});
});
