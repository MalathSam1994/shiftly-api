const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const registry=require('../reports/clinicalHandover/registry');
const {read}=require('../reports/clinicalHandover/workload');
const {excel}=require('../reports/clinicalHandover/excel');
const input={divisionId:1,departmentId:39,unitId:2,shiftDate:'2026-09-23'};
const def=registry.report('workload_and_continuity');
test('daily workload requires only four selectors and rejects removed comparison filters',()=>{
 assert.equal(def.title,'Daily workload and assignments');assert.deepEqual(def.parameters,Object.keys(input));assert.deepEqual(def.required,Object.keys(input));
 assert.deepEqual(registry.parameters(def,input),{...input,groupBy:'shift',sortBy:'staff'});
 for(const key of Object.keys(input)){const p={...input};delete p[key];assert.throws(()=>registry.parameters(def,p));}
 for(const key of ['shiftTypeId','incomingContextId','outgoingContextId','assignedStaffId','staffTypeId','fromDate','toDate'])
  assert.throws(()=>registry.parameters(def,{...input,[key]:1}),/not supported/);
 assert.throws(()=>registry.parameters(def,{...input,sortBy:'workload'}));
 assert.equal(registry.parameters(def,{divisionId:1},{partial:true}).divisionId,1);
});
async function dataset(){
 const interval={shift:'Day',start:'2026-09-23T07:00:00+02:00',end:'2026-09-23T19:30:00+02:00',observedAt:'2026-09-23T19:29:59.999999+02:00'};
 const value={context:{version:2,date:input.shiftDate,completeDay:true,reference:'2026-09-23T23:59:59.999999+02:00',shifts:[interval]},
  totals:{staff:1,shifts:1,patients:1,aboveLimit:0},notes:['Missing capacity stays unavailable.'],
  staff:[{...interval,rowKey:'1:2',userId:'2',staff:'=SUM(1,2)',role:'RN',unitPatients:1,unitWorkload:0,fullWorkload:0,capacity:null,utilization:null,status:'Not enough records'}],
  allocations:[{...interval,rowKey:'1:3',encounterId:'3',patient:'مريض',encounter:'00001',staff:'=SUM(1,2)',workload:0,status:'Assigned'}]};
 const d=await read({query:async(sql,args)=>{assert.match(sql,/fn_handover_daily_workload\(\$1::integer,\$2::jsonb\)/);assert.deepEqual(args,[271,input]);return {rows:[{value}]};}},{actor:271,parameters:input});
 return {...d,reportId:def.id,title:def.title,scopeLabel:'ED',businessTimezone:'Europe/Berlin',generatedAt:'2026-10-03T14:00:00+02:00',rowCount:2};
}
test('adapter preserves unknown values and contains only useful staff and assignment columns',async()=>{
 const d=await dataset();assert.deepEqual(d.sections.map(s=>s.id),['staff','allocations']);assert.deepEqual(d.metricDefinitions,[]);
 assert.equal(d.sections[0].rows[0].capacity,null);assert.ok(d.sections.every(s=>s.columns.every(c=>!['rowKey','userId','encounterId','evidence','side'].includes(c.key))));
});
test('compact Excel keeps offsets, literal text, multilingual names, leading zeros and unknown limits',async()=>{
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(await dataset()));
 assert.deepEqual(book.worksheets.map(s=>s.name),['Overview','Staff workload','Patient assignments']);
 const staff=book.getWorksheet('Staff workload'),patient=book.getWorksheet('Patient assignments');
 assert.equal(staff.getCell('E2').value,'=SUM(1,2)');assert.equal(staff.getCell('E2').type,ExcelJS.ValueType.String);
 assert.equal(staff.getCell('J2').value,'Not recorded');assert.equal(staff.getCell('H2').value,0);
 assert.equal(patient.getCell('F2').value,'00001');assert.equal(patient.getCell('E2').value,'مريض');
 assert.equal(staff.getCell('B2').value,'2026-09-23T07:00:00+02:00');
});
test('empty export explains unavailable records',async()=>{
 const d=await dataset();for(const s of d.sections){s.rows=[];s.total=0;}d.rowCount=0;
 const book=new ExcelJS.Workbook();await book.xlsx.load(await excel(d));
 assert.equal(book.getWorksheet('Staff workload').getCell('A2').value,'No staff workload records available for this date.');
});
test('daily and original saved report exports retain separate complete section contracts',async()=>{
 const path=require.resolve('../db'),old=require.cache[path];require.cache[path]={id:path,filename:path,loaded:true,exports:{}};
 const {exportData,preview}=require('../reports/clinicalHandover/service');if(old)require.cache[path]=old;else delete require.cache[path];
 const d=await dataset();assert.equal(exportData(d).rowCount,2);assert.equal(preview(d,'staff',0,1).sections[0].rows.length,1);
 assert.throws(()=>exportData({...d,sections:d.sections.slice(0,1)}),/Every declared section/);
 const legacy={...d,workloadContext:{},sections:[...d.sections,{...d.sections[0],id:'continuity',rows:[],total:0}]};
 assert.equal(exportData(legacy).rowCount,2);assert.throws(()=>exportData({...legacy,sections:d.sections}),/Every declared section/);
});
