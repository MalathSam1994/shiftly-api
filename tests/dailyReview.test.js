const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read}=require('../reports/clinicalHandover/reviewFollowUp');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:39,unitId:2,shiftDate:'2026-09-23'};
const def=registry.report('handover_review_follow_up');
async function coverage(){
 const value={context:{version:4,date:'2026-10-05',future:true,shifts:[
  {key:'1',label:'Day 12.5h',hours:'07:00 - 19:30',scheduled:2,required:2,staff:'Nurse A\nNurse B'},
  {key:'2',label:'Night 12.5h',hours:'19:00 - 07:30 (+1 day)',scheduled:0,required:2,staff:'No staff scheduled'}]},
  totals:{patients:2,shifts:2,assigned:1,unassigned:1,unscheduled:2},scopePairs:[{division_id:1,department_id:38}],notes:['Recorded plan'],
  rows:[
   {encounterId:'01',patient:'مريض\n00001 | 00002',location:'ICU / A',shiftKey:'1',shift:'Day',state:'ASSIGNED',nurse:'=SUM(1,2)',nurseScheduled:true,publishedAt:'2026-10-03T17:00:00+02:00'},
   {encounterId:'01',patient:'مريض\n00001 | 00002',location:'ICU / A',shiftKey:'2',shift:'Night',state:'NO_SCHEDULE'},
   {encounterId:'02',patient:'Patient B',location:'ICU / B',shiftKey:'1',shift:'Day',state:'SCHEDULED_UNASSIGNED',unassignedStaff:'Osama\nusertest'},
   {encounterId:'02',patient:'Patient B',location:'ICU / B',shiftKey:'2',shift:'Night',state:'NO_SCHEDULE'}]};
 const d=await read({query:async(sql,args)=>{assert.match(sql,/fn_handover_assignment_coverage\(\$1::integer,\$2::jsonb\)/);assert.deepEqual(args,[271,input]);return{rows:[{value}]};}},{actor:271,parameters:input});
 return {...d,reportId:def.id,title:def.title,scopeLabel:'ICU',businessTimezone:'Europe/Berlin',generatedAt:'2026-10-03T18:00:00+02:00',rowCount:4};
}
test('v4 includes assigned, scheduled-unassigned and missing-schedule cells with four filters',async()=>{
 const d=await coverage();assert.equal(def.timeBasis,'DAY_PLAN');assert.deepEqual(def.sections.map(s=>s.id),['coverage']);
 assert.deepEqual(d.sections.map(s=>s.id),['coverage']);assert.equal(d.sections[0].total,4);assert.equal(d.sections[0].evidenceBasis,'PLAN');
 assert.deepEqual(d.summaries.map(m=>m.value),[2,2,1,1,2]);assert.deepEqual(d.authorizationPairs,[{division_id:1,department_id:38}]);
 assert.equal(registry.parameters(def,{...input,shiftDate:'2026-10-05'}).shiftDate,'2026-10-05');
});
test('v4 Excel pivots all cells, labels and colors missing schedules distinctly, keeps literal source data',async()=>{
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(await coverage()));
 assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Patient coverage','Coverage data']);
 const s=book.getWorksheet('Patient coverage');assert.equal(s.rowCount,4);assert.equal(s.columnCount,3);
 assert.equal(s.getCell('B4').value,'□ Scheduled / no assignment\nOsama\nusertest\nStaff without patient assignments');assert.equal(s.getCell('C4').value,'□ No schedule / no assignment');
 assert.equal(s.getCell('C4').font.color.argb,'FFC43C3C');assert.equal(s.getCell('B4').font.color.argb,'FF78828C');
 assert.equal(s.getCell('B1').fill.fgColor.argb,'FFFFF2CC');assert.equal(s.getCell('C1').fill.fgColor.argb,'FFFFF2CC');
 assert.equal(book.getWorksheet('Coverage data').getCell('G4').value,'Osama\nusertest');
 assert.equal(s.getCell('A3').value,'مريض\n00001 | 00002\nICU / A');assert.equal(s.getCell('A3').alignment.readingOrder,'rtl');
 assert.match(s.getCell('B3').value,/^=SUM\(1,2\)\nPublished 2026-10-03T17:00:00\+02:00/);
 assert.equal(s.getCell('B3').type,ExcelJS.ValueType.String);assert.equal(book.getWorksheet('Coverage data').rowCount,5);
 const d=await coverage();d.sections[0].rows=[];d.sections[0].total=0;d.rowCount=0;
 const empty=new ExcelJS.Workbook();await empty.xlsx.load(await excel(d));
 assert.equal(empty.getWorksheet('Patient coverage').getCell('C2').value,'0 / 2 required\nNo staff scheduled');
});
test('daily review exposes four required selectors and rejects old cohort/status filters',()=>{
 assert.equal(def.title,'Patient assignment timeline');assert.deepEqual(def.parameters,Object.keys(input));assert.deepEqual(def.required,Object.keys(input));
 assert.deepEqual(registry.parameters(def,input),{...input,groupBy:'timeline',sortBy:'effectiveTime'});
 for(const key of Object.keys(input)){const p={...input};delete p[key];assert.throws(()=>registry.parameters(def,p));}
 for(const key of ['fromDate','toDate','shiftTypeId','reviewStatus','reviewerId','incomingContextId','outgoingContextId'])
  assert.throws(()=>registry.parameters(def,{...input,[key]:1}),/not supported/);
 assert.throws(()=>registry.parameters(def,{...input,sortBy:'reviewedTime'}));
 assert.equal(registry.parameters(def,{divisionId:1},{partial:true}).divisionId,1);
 for(const report of registry.reports)assert.ok(report.parameters.includes('shiftDate'));
});
async function dataset(){
 const value={context:{version:3,date:input.shiftDate,completeDay:true,reference:'2026-09-23T23:59:59.999999+02:00'},
  totals:{changes:1,patients:1},scopePairs:[{division_id:1,department_id:39}],notes:['Publication time; before/after is recorded history.'],
  changes:[{changeId:'publication:1',encounterId:'1',patientName:'مريض',patientId:'00001',encounter:'00002',patient:'مريض\n00001 | 00002',
   time:'2026-09-23T07:00:00+02:00',beforeShift:'Not recorded',beforeNurse:'Not recorded',afterShift:'Day\n2026-09-23\n07:00 - 19:30',afterNurse:'=SUM(1,2)'}]};
 const d={rowGrain:'patient / published change',reviewContext:value.context,totals:value.totals,authorizationPairs:value.scopePairs,
  summaries:[{label:'Assignment changes',value:1,availability:'AVAILABLE',definition:'Published changes'},{label:'Patients',value:1,availability:'AVAILABLE',definition:'Patients'}],
  metricDefinitions:[],sourceLimitations:value.notes,sections:[{id:'changes',title:'Assignment timeline',grain:'patient / published change',evidenceBasis:'HISTORICAL',availability:'AVAILABLE',limitations:[],
  columns:['time','patient','beforeShift','beforeNurse','afterShift','afterNurse'].map(key=>({key,label:key,type:key==='time'?'datetime':'text'})),rows:value.changes,total:1}]};
 return {...d,reportId:def.id,title:def.title,scopeLabel:'ED',businessTimezone:'Europe/Berlin',generatedAt:'2026-10-03T15:00:00+02:00',rowCount:1};
}
test('saved v3 preserves one complete before/after row and private counterpart scope',async()=>{
 const d=await dataset();assert.deepEqual(d.sections.map(s=>s.id),['changes']);assert.deepEqual(d.metricDefinitions,[]);
 assert.equal(d.sections[0].rows[0].beforeNurse,'Not recorded');assert.deepEqual(d.summaries.map(s=>s.value),[1,1]);
 assert.deepEqual(d.sections[0].columns.map(c=>c.key),['time','patient','beforeShift','beforeNurse','afterShift','afterNurse']);
 assert.deepEqual(d.authorizationPairs,[{division_id:1,department_id:39}]);
});
test('six-column Excel preserves literal names, identifiers, multilingual text, offsets and before/after colors',async()=>{
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(await dataset()));
 assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Assignment timeline']);const sheet=book.getWorksheet('Assignment timeline');
 assert.equal(sheet.columnCount,6);assert.equal(sheet.getCell('B2').value,'مريض\n00001 | 00002');
 assert.equal(sheet.getCell('F2').value,'=SUM(1,2)');assert.equal(sheet.getCell('F2').type,ExcelJS.ValueType.String);
 assert.equal(sheet.getCell('A2').value,'2026-09-23T07:00:00+02:00');assert.equal(sheet.getCell('C2').value,'Not recorded');
 assert.notDeepEqual(sheet.getCell('C2').fill,sheet.getCell('E2').fill);
 assert.equal(sheet.getCell('C1').font.color.argb,'FF243746');assert.equal(sheet.getCell('E1').font.color.argb,'FF243746');
 assert.equal(sheet.getCell('B2').alignment.readingOrder,'rtl');
 assert.equal(sheet.getCell('E2').value,'Day\n2026-09-23\n07:00 - 19:30');
});
test('empty timeline explains that no published changes were recorded',async()=>{
 const d=await dataset();d.sections[0].rows=[];d.sections[0].total=0;d.rowCount=0;d.summaries[0].value=0;d.summaries[1].value=0;
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(d));
 assert.equal(book.getWorksheet('Assignment timeline').getCell('A2').value,'No published assignment changes recorded during this date.');
 assert.equal(book.getWorksheet('Overview').getCell('B6').value,0);
});
test('timeline, compact review and original saved generations have separate complete export contracts',async()=>{
 const path=require.resolve('../db'),old=require.cache[path];require.cache[path]={id:path,filename:path,loaded:true,exports:{}};
 const {exportData,preview}=require('../reports/clinicalHandover/service');if(old)require.cache[path]=old;else delete require.cache[path];
 const current=await coverage();assert.equal(exportData(current).rowCount,4);assert.equal(preview(current,'coverage',0,1).reviewDetails,undefined);
 assert.throws(()=>exportData({...current,sections:[]}),/Every declared section/);
 const d=await dataset();assert.equal(exportData(d).rowCount,1);assert.equal(preview(d,'changes',0,1).reviewDetails,undefined);
 assert.throws(()=>exportData({...d,sections:[]}),/Every declared section/);
 const compact={...d,reviewContext:{version:2},sections:[{...d.sections[0],id:'reviews'}]};
 assert.equal(exportData(compact).rowCount,1);assert.equal(preview(compact,'reviews',0,1).reviewDetails,undefined);
 const extra=['members','lifecycle','gaps'].map(id=>({...d.sections[0],id,rows:[],total:0}));
 const legacy={...compact,reviewContext:{},sections:[...compact.sections,...extra]};
 assert.equal(exportData(legacy).rowCount,1);assert.deepEqual(preview(legacy,'reviews',0,1).reviewDetails,{members:[],lifecycle:[]});
 assert.throws(()=>exportData({...legacy,sections:compact.sections}),/Every declared section/);
});
