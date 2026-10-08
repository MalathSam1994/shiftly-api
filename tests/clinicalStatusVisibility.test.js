const test=require('node:test');
const assert=require('node:assert/strict');
const registry=require('../reports/clinicalHandover/registry');
const {describeClinicalAttention}=require('../services/clinicalAttentionDetails');

test('manual status selectors are hidden while encounter status and issue severity remain',()=>{
  assert.equal(registry.fields.clinicalStatus,undefined);
  assert.ok(!registry.fields.changeCategory.options.includes('CLINICAL_STATUS'));
  assert.ok(!registry.fields.eventType.options.includes('CLINICAL_STATUS'));
  assert.ok(registry.fields.patientStatus.options.includes('DISCHARGED'));
  assert.ok(registry.fields.severity.options.includes('CRITICAL'));
});
for (const name of ['patientSheet','unitSummary','shiftChanges']) test(name+' rejects the old database report shape',async()=>{
  const {read}=require('../reports/clinicalHandover/'+name);
  await assert.rejects(()=>read({query:async()=>({rows:[{value:{}}]})},{actor:271,parameters:{}}),
    e=>e.code==='REPORT_UPDATE_REQUIRED' && e.status===503);
});
for (const id of ['patient_handover_sheet','unit_handover_summary','changes_since_previous_shift']) test(id+' requires regeneration of saved manual-status reports',()=>{
  const old={reportId:id,sections:[{rows:[{clinicalStatus:'CRITICAL',summary:'Old note'}]}]};
  const original=JSON.stringify(old);
  assert.throws(()=>registry.assertClinicalPresentation(old,id,true),e=>e.code==='REPORT_LAYOUT_CHANGED'&&e.status===410);
  assert.equal(JSON.stringify(old),original);
  assert.doesNotThrow(()=>registry.assertClinicalPresentation({...old,clinicalStatusHidden:true},id,true));
});
test('review details keep assessment changes without manual status, summary or state-only actions',()=>{
  const data={historical:true,operations:[
    {encounter_id:1,operation_type:'CLINICAL_STATUS',before_state:{clinical_status:'WATCH'},
      after_state:{clinical_status:'CRITICAL',summary:'Secret old note'},score:3,previous_score:2,workload:4,previous_workload:2,adt_burden:1,previous_adt:0},
    {encounter_id:1,operation_type:'CLINICAL_STATUS',notes:'State only'},
  ]};
  const result=describeClinicalAttention(data);
  const records=result.sections.find(s=>s.id==='records').items;
  assert.equal(records.length,1);assert.match(records[0].title,/assessment/);
  assert.ok(records[0].fields.some(f=>f.label==='Score'));
  assert.doesNotMatch(JSON.stringify(records),/WATCH|CRITICAL|Secret old note|State only|clinical status/i);
  assert.equal(data.operations[0].after_state.clinical_status,'CRITICAL');
});
