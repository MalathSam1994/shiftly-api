// SQL owns daily scope, recorded active state, canonical grouping and direct links.
const c=(key,label,type='text')=>({key,label,type});
const columns=[c('priority','Priority'),c('title','Issue'),c('summary','Details'),
 c('affects','Affected patients / staff / scope'),c('firstDetected','First detected','datetime')];
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_daily_outstanding_issues($1::integer,$2::jsonb) value',[actor,parameters]);
 const d=rows[0].value;
 return {rowGrain:'One recorded outstanding issue at the selected daily cutoff.',issueContext:d.context,totals:d.totals,
  summaries:[
   {label:'Recorded outstanding issues',value:d.totals.issues,availability:'AVAILABLE',definition:'Recorded active primary issues, including earlier unresolved issues; historical evidence may be incomplete.'},
   {label:'Critical',value:d.totals.critical,availability:'AVAILABLE',definition:'Displayed issues with recorded Critical priority.'},
   {label:'Warning',value:d.totals.warning,availability:'AVAILABLE',definition:'Displayed issues with recorded Warning priority.'}],
  metricDefinitions:[],sourceLimitations:d.notes,
  sections:[{id:'issues',title:'Outstanding issues',grain:'recorded primary issue',
   evidenceBasis:d.context.historical?'HISTORICAL':'CURRENT',availability:'AVAILABLE',limitations:[],
   columns,rows:d.issues,total:d.issues.length}]};
}
// Only original saved generations use the five-section detail contract.
function pageDetails(data,offset,limit) {
 const ids=new Set(data.sections.find(s=>s.id==='issues').rows.slice(offset,offset+limit).map(r=>r.issueId));
 return Object.fromEntries(['sources','lifecycle','associations'].map(id=>[id,data.sections.find(s=>s.id===id).rows.filter(r=>ids.has(r.issueId))]));
}
module.exports={read,pageDetails};
