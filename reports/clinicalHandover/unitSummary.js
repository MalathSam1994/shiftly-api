// PostgreSQL owns the daily cutoff, patient cohort and movement counts.
const column=(key,label,type='text')=>({key,label,type});
const columns={
  overview:[column('measure','Measure'),column('value','Count','number')],
  patients:[column('location','Room / bed'),column('patientName','Patient'),column('encounter','Encounter','identifier'),
    column('clinicalStatus','Clinical status','status'),column('acuity','Acuity'),column('assessedAt','Last assessed','datetime')],
};
async function read(client,{actor,parameters}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_unit_daily_summary($1,$2::jsonb) value',[actor,parameters]);
  const data=rows[0].value;
  const section=(id,title,grain)=>({id,title,grain,evidenceBasis:data.unitContext.basis,availability:'AVAILABLE',limitations:[],
    columns:columns[id],rows:data[id],total:data[id].length});
  return {
    rowGrain:'One encounter in the unit at the end of the selected date, or at generation time today.',
    unitContext:data.unitContext,dailySummary:data.dailySummary,totals:data.totals,
    summaries:[{label:'Patients',value:data.dailySummary.patients,availability:'AVAILABLE',definition:'Patients located by dated history or an encounter unit saved by the report time.'}],
    metricDefinitions:[],sourceLimitations:data.notes,
    sections:[section('overview','Overview','measure per unit/day'),section('patients','Patients','encounter at the daily cutoff')],
  };
}
module.exports={read};
