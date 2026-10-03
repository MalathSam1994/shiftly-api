// SQL owns the expected shifts, patient cohort and recorded coverage states.
const c=(key,label,type='text')=>({key,label,type});
const columns=[c('patient','Patient'),c('location','Room / bed'),c('shift','Shift'),
 c('nurse','Published nurse'),c('state','Coverage','status'),c('publishedAt','Time published','datetime')];
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_assignment_coverage($1::integer,$2::jsonb) value',[actor,parameters]);
 const d=rows[0].value;
 return {rowGrain:'One patient / expected shift, including unpublished and unscheduled coverage.',reviewContext:d.context,totals:d.totals,authorizationPairs:d.scopePairs,
  summaries:[['Patients','patients'],['Shifts','shifts'],['Assigned','assigned'],['Scheduled, unassigned','unassigned'],['No schedule or assignment','unscheduled']].map(([label,key])=>({label,value:d.totals[key],availability:'AVAILABLE',definition:'Distinct patients and expected shifts; coverage counts are patient/shift cells.'})),
  metricDefinitions:[],sourceLimitations:d.notes,
  sections:[{id:'coverage',title:'Patient assignment matrix',grain:'patient / expected shift',evidenceBasis:d.context.future?'PLAN':'MIXED',
   availability:'AVAILABLE',limitations:[],columns,rows:d.rows,total:d.rows.length}]};
}
// Original saved generations retain their supporting detail contract.
function pageDetails(data,offset,limit) {
 const ids=new Set(data.sections.find(s=>s.id==='reviews').rows.slice(offset,offset+limit).map(r=>r.reviewId));
 return Object.fromEntries(['members','lifecycle'].map(id=>[id,data.sections.find(s=>s.id===id).rows.filter(r=>ids.has(r.reviewId))]));
}
module.exports={read,pageDetails};
