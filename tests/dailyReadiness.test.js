const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read}=require('../reports/clinicalHandover/readiness');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:39,unitId:2,shiftDate:'2026-09-23'};
const definition=registry.report('incoming_shift_readiness');
test('daily readiness requires exactly four fields and removes target/type/sort choices',()=>{
 assert.equal(definition.title,'Daily staffing readiness');
 assert.deepEqual(definition.parameters,Object.keys(input));assert.deepEqual(definition.required,Object.keys(input));
 assert.deepEqual(registry.parameters(definition,input),{...input,groupBy:'unit',sortBy:'shift'});
 for(const key of Object.keys(input)){const p={...input};delete p[key];assert.throws(()=>registry.parameters(definition,p));}
 for(const key of ['targetContextKey','shiftTypeId','incomingContextId','outgoingContextId','fromDate','toDate'])
  assert.throws(()=>registry.parameters(definition,{...input,[key]:'1'}),/not supported/);
 assert.throws(()=>registry.parameters(definition,{...input,sortBy:'status'}));
 assert.throws(()=>registry.parameters(registry.report('workload_and_continuity'),input),/required/);
});
async function dataset(){
 const value={context:{version:2,date:input.shiftDate,historical:true,basis:'HISTORICAL'},
  totals:{approvedStaff:1,shifts:2,staffingGaps:1},notes:['Historical clinical eligibility is not available.'],
  staffing:[{groupKey:'1',shift:'Night',hours:'19:00 - 07:00 (+1 day)',staffType:'RN',required:2,approved:1,eligible:null,gap:1,note:null},
   {groupKey:'2',shift:'Day',hours:null,staffType:'RN',required:null,approved:0,eligible:null,gap:null,note:null}],
  staff:[{assignmentId:'0007',staff:'=SUM(1,2)',staffType:'RN',shift:'Night',hours:'19:00 - 07:00 (+1 day)',
   start:'2026-09-23T19:00:00+02:00',end:'2026-09-24T07:00:00+02:00',approval:'Approved',clinicalCheck:'Not available',notes:'ملاحظة'}]};
 const data=await read({query:async(sql,args)=>{assert.match(sql,/fn_handover_daily_readiness/);assert.deepEqual(args,[271,input]);return {rows:[{value}]};}},{actor:271,parameters:input});
 return {...data,reportId:definition.id,title:definition.title,generatedAt:'2026-10-03T10:00:00+02:00',businessTimezone:'Europe/Berlin',scopeLabel:'ED',rowCount:3};
}
test('adapter preserves SQL counts and unknown eligibility in two compact sections',async()=>{
 const data=await dataset();assert.deepEqual(data.sections.map(s=>s.id),['staffing','staff']);
 assert.deepEqual(data.totals,{approvedStaff:1,shifts:2,staffingGaps:1});assert.deepEqual(data.metricDefinitions,[]);
 assert.ok(data.sections.every(s=>!s.columns.some(c=>/Id$|Key$/.test(c.key))));
 assert.equal(data.sections[0].rows[0].eligible,null);
});
test('compact Excel preserves zero/unknown, staff text, exact overnight times and notes',async()=>{
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(await dataset()));
 assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Staffing by shift','Scheduled staff']);
 const staffing=book.getWorksheet('Staffing by shift'),staff=book.getWorksheet('Scheduled staff');
 assert.equal(staffing.getCell('F2').value,'Not available');assert.equal(staffing.getCell('E3').value,0);
 assert.equal(staffing.getCell('D3').value,'Not recorded');assert.equal(staffing.getCell('G3').value,'Not recorded');
 assert.equal(staff.getCell('A2').value,'=SUM(1,2)');assert.equal(staff.getCell('A2').type,ExcelJS.ValueType.String);
 assert.equal(staff.getCell('E2').value,'2026-09-24T07:00:00+02:00');assert.equal(staff.getCell('H2').value,'ملاحظة');
});
test('empty export describes missing records without a ready/safe claim',async()=>{
 const data=await dataset();for(const s of data.sections){s.rows=[];s.total=0;}
 data.rowCount=0;data.totals={approvedStaff:0,shifts:0,staffingGaps:0};
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(data));
 assert.equal(book.getWorksheet('Scheduled staff').getCell('A2').value,'No staff scheduled for this date.');
 assert.equal(book.getWorksheet('Staffing by shift').getCell('A2').value,'No staffing requirements or roster recorded for this date.');
});
test('legacy saved readiness retains all eight sections; new reports require both compact sections',async()=>{
 const dbPath=require.resolve('../db'),previous=require.cache[dbPath];require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{}};
 const {exportData}=require('../reports/clinicalHandover/service');
 if(previous)require.cache[dbPath]=previous;else delete require.cache[dbPath];
 const data=await dataset();assert.equal(exportData(data).rowCount,3);
 assert.throws(()=>exportData({...data,sections:data.sections.slice(0,1)}),/Every declared section/);
 const ids=['findings','overview','requirements','staff','patients','competencies','capacity','pending'];
 const legacy={...data,readinessContext:{contextKey:'ROSTER:1'},rowCount:0,
  sections:ids.map(id=>({id,grain:'record',evidenceBasis:'MIXED',availability:'AVAILABLE',columns:[],rows:[],total:0,limitations:[]}))};
 assert.equal(exportData(legacy).rowCount,0);
 assert.throws(()=>exportData({...legacy,sections:legacy.sections.slice(1)}),/Every declared section/);
});
