// SQL owns daily roster groups, staffing gaps and canonical clinical checks.
const c=(key,label,type='text')=>({key,label,type});
const columns={
 staffing:[c('shift','Shift'),c('hours','Hours'),c('staffType','Role'),c('required','Required','number'),
  c('approved','Approved','number'),c('eligible','Clinically eligible','number'),c('gap','Staff shortfall','number'),c('note','Note')],
 staff:[c('staff','Staff'),c('staffType','Role'),c('shift','Shift'),c('start','Start','datetime'),c('end','End','datetime'),
  c('approval','Approval'),c('clinicalCheck','Clinical check'),c('notes','Note')],
};
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_daily_readiness($1,$2::jsonb) value',[actor,parameters]);
 const d=rows[0].value;
 return {rowGrain:'Staffing groups and scheduled staff for all shifts starting on the selected business date.',
  readinessContext:d.context,totals:d.totals,metricDefinitions:[],sourceLimitations:d.notes,
  summaries:[
   {label:'Approved staff',value:d.totals.approvedStaff,availability:'AVAILABLE',definition:'Distinct approved working staff across the department on this date.'},
   {label:'Shifts',value:d.totals.shifts,availability:'AVAILABLE',definition:'Distinct recorded period and shift-type groups.'},
   {label:'Staffing gaps',value:d.totals.staffingGaps,availability:'AVAILABLE',definition:'Groups with fewer approved staff than their recorded requirement; unknown requirements remain separate.'}],
  sections:Object.entries(columns).map(([id,cols])=>({id,title:id==='staffing'?'Staffing by shift':'Scheduled staff',
   grain:id==='staffing'?'period / shift type / role':'recorded roster assignment',evidenceBasis:d.context.basis,
   availability:'AVAILABLE',limitations:[],columns:cols,rows:d[id],total:d[id].length})),
 };
}
module.exports={read};
