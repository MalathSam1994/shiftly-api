const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read,pageDetails}=require('../reports/clinicalHandover/outstandingIssues');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:39,unitId:2,shiftDate:'2026-10-03'};
const definition=registry.report('outstanding_handover_issues');
test('daily outstanding issues uses exactly four required fields without old mode validation',()=>{
 assert.equal(definition.title,'Daily outstanding issues');
 assert.deepEqual(definition.parameters,Object.keys(input));assert.deepEqual(definition.required,Object.keys(input));
 assert.deepEqual(registry.parameters(definition,input),{...input,groupBy:'priority',sortBy:'severity'});
 for(const key of Object.keys(input)){const p={...input};delete p[key];assert.throws(()=>registry.parameters(definition,p));}
 for(const key of ['issueTimeMode','referenceTime','shiftTypeId','shiftContextId','issueDomain','issueCategory','issueReason','severity','issueLifecycle','fromDate','toDate'])
  assert.throws(()=>registry.parameters(definition,{...input,[key]:'1'}),/not supported/);
 assert.throws(()=>registry.parameters(definition,{...input,sortBy:'firstDetected'}));
 assert.throws(()=>registry.parameters(definition,{...input,groupBy:'unit'}));
 assert.equal(registry.parameters(definition,{divisionId:1},{partial:true}).divisionId,1);
 assert.throws(()=>registry.parameters(registry.report('workload_and_continuity'),input),/required/);
});
async function dataset(){
 const value={context:{version:2,date:input.shiftDate,completeDay:false,historical:false,reference:'2026-10-03T13:29:00+02:00'},
  totals:{issues:1,critical:1,warning:0},notes:['One recorded source/history gap may leave issues out.'],
  issues:[{issueId:'0007',priority:'Critical',title:'=SUM(1,2)',summary:'ملاحظة',affects:'Patient: Sample (0001)',firstDetected:'2026-09-23T22:30:00+02:00'}]};
 const data=await read({query:async(sql,args)=>{assert.match(sql,/fn_handover_daily_outstanding_issues\(\$1::integer,\$2::jsonb\)/);assert.deepEqual(args,[271,input]);return {rows:[{value}]};}},{actor:271,parameters:input});
 return {...data,reportId:definition.id,title:definition.title,generatedAt:'2026-10-03T13:29:00+02:00',businessTimezone:'Europe/Berlin',scopeLabel:'ED',rowCount:1};
}
test('daily adapter keeps one issue row and concise notes without exposing technical IDs',async()=>{
 const d=await dataset();assert.deepEqual(d.sections.map(s=>s.id),['issues']);assert.deepEqual(d.metricDefinitions,[]);
 assert.deepEqual(d.totals,{issues:1,critical:1,warning:0});assert.equal(d.sourceLimitations.length,1);
 assert.ok(d.sections[0].columns.every(c=>!['issueId','evidence','targetScope','stateBasis'].includes(c.key)));
});
test('two-sheet Excel preserves complete names, notes, literal formula text, zeros and offset times',async()=>{
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(await dataset()));
 assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Outstanding issues']);
 const sheet=book.getWorksheet('Outstanding issues');assert.equal(sheet.rowCount,2);
 assert.equal(sheet.getCell('B2').value,'=SUM(1,2)');assert.equal(sheet.getCell('B2').type,ExcelJS.ValueType.String);
 assert.equal(sheet.getCell('C2').value,'ملاحظة');assert.equal(sheet.getCell('D2').value,'Patient: Sample (0001)');
 assert.equal(sheet.getCell('E2').value,'2026-09-23T22:30:00+02:00');
 const overview=book.getWorksheet('Overview');let warning;
 overview.eachRow(row=>{if(row.getCell(1).value==='Warning')warning=row.getCell(2).value;});
 assert.equal(warning,0);
});
test('empty export says no recorded issues without claiming that none exist',async()=>{
 const d=await dataset();d.sections[0].rows=[];d.sections[0].total=0;d.rowCount=0;d.totals={issues:0,critical:0,warning:0};
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(d));
 assert.equal(book.getWorksheet('Outstanding issues').getCell('A2').value,'No outstanding issues recorded for this unit at the report time.');
});
test('saved daily preview/export and original five-section detail contracts stay separate',async()=>{
 const path=require.resolve('../db'),previous=require.cache[path];require.cache[path]={id:path,filename:path,loaded:true,exports:{}};
 const {preview,exportData}=require('../reports/clinicalHandover/service');
 if(previous)require.cache[path]=previous;else delete require.cache[path];
 const d=await dataset();assert.equal(exportData(d).rowCount,1);assert.equal(preview(d,'issues',0,1).issueDetails,undefined);
 assert.throws(()=>exportData({...d,sections:[]}),/Every declared section/);
 const legacy={...d,issueContext:{historical:false},rowCount:2,sections:[
  {...d.sections[0],rows:[{issueId:'7'}],total:1},
  ...['sources','lifecycle','associations','gaps'].map(id=>({...d.sections[0],id,rows:id==='sources'?[{issueId:'7'}]:[],total:id==='sources'?1:0}))]};
 assert.equal(exportData(legacy).rowCount,2);
 assert.deepEqual(pageDetails(legacy,0,1),{sources:[{issueId:'7'}],lifecycle:[],associations:[]});
 assert.equal(preview(legacy,'issues',0,1).issueDetails.sources.length,1);
 assert.throws(()=>exportData({...legacy,sections:legacy.sections.slice(0,1)}),/Every declared section/);
});
