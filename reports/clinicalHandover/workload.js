// PostgreSQL owns dated publication selection, unit scope and workload arithmetic.
const c=(key,label,type='text')=>({key,label,type});
const columns={
 staff:[c('shift','Shift'),c('start','Shift start','datetime'),c('end','Shift end','datetime'),c('observedAt','Observed at','datetime'),
  c('staff','Staff'),c('role','Role'),c('unitPatients','Known unit patients','number'),c('unitWorkload','Unit workload','number'),
  c('fullWorkload','Total workload','number'),c('capacity','Recorded workload limit','number'),c('utilization','Utilization (%)','number'),c('status','Status')],
 allocations:[c('shift','Shift'),c('start','Shift start','datetime'),c('end','Shift end','datetime'),c('observedAt','Observed at','datetime'),
  c('patient','Patient'),c('encounter','Encounter','identifier'),c('staff','Published staff'),c('workload','Workload points','number'),c('status','Assignment')],
};
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_daily_workload($1::integer,$2::jsonb) value',[actor,parameters]);
 const d=rows[0].value;
 const section=(id,title)=>({id,title,grain:id==='staff'?'person / actual shift':'encounter / actual shift',evidenceBasis:d.context.completeDay?'HISTORICAL':'MIXED',availability:'AVAILABLE',
  columns:columns[id],rows:d[id],total:d[id].length,limitations:[]});
 return {rowGrain:'Recorded staff workload and patient assignments per shift on the selected date.',workloadContext:d.context,totals:d.totals,
  summaries:[['Shifts','shifts'],['Staff','staff'],['Patients','patients'],['Above recorded limit','aboveLimit']].map(([label,key])=>({label,value:d.totals[key],availability:'AVAILABLE',definition:''})),
  metricDefinitions:[],sourceLimitations:d.notes,sections:[section('staff','Staff workload'),section('allocations','Patient assignments')]};
}
module.exports={read};
