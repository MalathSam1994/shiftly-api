const {assertClinicalPresentation}=require('./registry');
// PostgreSQL owns the daily cutoff, historical cohort and active care factors.
const column=(key,label,type='text')=>({key,label,type});
const columns={
  patients:[column('location','Room / bed'),column('patientName','Patient'),column('patientId','Patient ID','identifier'),
    column('encounter','Encounter','identifier'),
    column('acuity','Acuity'),column('assessedAt','Last assessed','datetime')],
  factors:[column('patientName','Patient'),column('patientId','Patient ID','identifier'),column('encounter','Encounter','identifier'),
    column('factor','Care factor'),column('value','Recorded value','number'),column('notes','Notes')],
};
async function read(client,{actor,parameters}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_patient_daily_sheet($1,$2::jsonb) value',[actor,parameters]);
  const data=rows[0].value;
  assertClinicalPresentation(data,'patient_handover_sheet');
  return {
    clinicalStatusHidden:true, rowGrain:'One encounter in the unit at the end of the selected date, or at generation time today.',
    patientContext:data.patientContext,totals:data.totals,
    summaries:[{label:'Patients',value:data.totals.patients,availability:'AVAILABLE',definition:'Patients located by dated history or an encounter unit saved by the report time.'}],
    metricDefinitions:[],sourceLimitations:data.notes,
    sections:Object.entries(columns).map(([id,cols])=>({id,title:id==='patients'?'Patients':'Care factors',
      grain:id==='patients'?'encounter at the daily cutoff':'active recorded factor per encounter',
      evidenceBasis:data.patientContext.basis,availability:'AVAILABLE',limitations:[],columns:cols,rows:data[id],total:data[id].length})),
  };
}
function pageDetails(dataset,offset,limit) {
  const patients=dataset.sections.find(s=>s.id==='patients').rows.slice(offset,offset+limit);
  // Stable encounter IDs also support retained generations with the old sections.
  return Object.fromEntries(patients.map(p=>[p.encounterId,Object.fromEntries(dataset.sections.filter(s=>s.id!=='patients').map(s=>[s.id,s.rows.filter(r=>r.encounterId===p.encounterId)]))]));
}
module.exports={read,pageDetails};
