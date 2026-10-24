const test=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const {read}=require('../reports/clinicalHandover/patientSheet');
const {excel}=require('../reports/clinicalHandover/excel');
const {dailyTriageQuery,addDailyTriage}=require('../reports/clinicalHandover/triage');

test('report query uses clinical cutoff and SQL full-cohort distribution',()=>{
  for(const kind of ['patient','unit']) {
    const sql=dailyTriageQuery(kind);
    assert.match(sql,/fn_clinical_triage_snapshots/);
    assert.match(sql,new RegExp(`${kind}Context,reference`));
    assert.match(sql,/fn_clinical_triage_distribution\(snapshots\)/);
    assert.doesNotMatch(sql,/avg\(|generatedAt/i);
  }
});

test('ED export preserves ESI and unknown separately with provenance and no nursing changes',async()=>{
  const raw={clinicalStatusHidden:true,patientContext:{version:2,reference:'2026-10-24T12:00:00Z',basis:'HISTORICAL'},
    notes:[],totals:{patients:2,factors:0},factors:[],patients:[
      {encounterId:'1',patientName:'Patient A',acuity:'High',workload:8,assessedAt:'2026-10-24T11:30:00Z'},
      {encounterId:'2',patientName:'Patient B',acuity:'Low',workload:2}],
    triageSnapshots:{'1':{applicable:true,level:2,initial_level:3,assessed_at:'2026-10-24T10:00:00Z',source:'MANUAL',assessed_by_name:'Authorized clinician'},
      '2':{applicable:true,level:null,initial_level:null}},
    triageDistribution:{total:2,unrecorded:1,levels:[1,2,3,4,5].map(level=>({level,count:level===2?1:0}))}};
  const data=await read({query:async()=>({rows:[{value:structuredClone(raw)}]})},{actor:4,parameters:{}});
  const rows=data.sections[0].rows;
  assert.equal(rows[0].triageLevel,'ESI 2');assert.equal(rows[0].triageInitial,'ESI 3');
  assert.equal(rows[1].triageLevel,'Not recorded');assert.equal(rows[0].workload,8);
  const bytes=await excel({...data,reportId:'patient_handover_sheet',title:'Patient handover sheet',
    generatedAt:'2026-10-24T12:01:00Z',businessTimezone:'UTC',scopeLabel:'ED'});
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  const patients=book.getWorksheet('Patients');
  const index=data.sections[0].columns.findIndex(c=>c.key==='triageLevel')+1;
  assert.equal(patients.getCell(2,index).value,'ESI 2');
  assert.equal(patients.getCell(2,index).font.color.argb,'FF9A3412');
  assert.equal(patients.getCell(3,index).value,'Not recorded');
  const values=book.getWorksheet('Overview').getSheetValues().flat(2);
  assert.ok(values.includes('ED triage not recorded'));
});

test('non-ED report stays free of triage columns and fabricated ESI',()=>{
  const columns=[{key:'acuity',label:'Acuity'}];
  const data={patients:[{encounterId:'1',acuity:'High'}],triageSnapshots:{'1':{applicable:false,level:null}}};
  assert.equal(addDailyTriage(data,columns),columns);
  assert.equal(data.patients[0].triageLevel,undefined);
});
