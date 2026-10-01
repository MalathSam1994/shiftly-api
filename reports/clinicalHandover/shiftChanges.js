// SQL owns the day interval, source identity, predecessors and authorized deltas.
const column=(key,label,type='text')=>({key,label,type});
const columns=[column('effectiveAt','Time','datetime'),column('patientName','Patient'),column('patientId','Patient ID','identifier'),
  column('encounter','Encounter','identifier'),column('change','What changed'),column('before','Before'),column('after','After'),column('notes','Note')];
async function read(client,{actor,parameters}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_daily_changes($1,$2::jsonb) value',[actor,parameters]);
  const data=rows[0].value;
  return {rowGrain:'One changed item during the selected business day.',
    changeContext:data.changeContext,totals:data.totals,authorizationPairs:data.scopePairs,
    summaries:[{label:'Recorded changes',value:data.totals.changes,availability:'AVAILABLE',definition:'Changed items; multiple items may belong to the same event.'},
      {label:'Patients with changes',value:data.totals.changedEncounters,availability:'AVAILABLE',definition:'Distinct encounters with a displayed change.'}],
    metricDefinitions:[],sourceLimitations:data.notes,
    sections:[{id:'changes',title:'Changes',grain:'changed item during the selected day',evidenceBasis:data.changeContext.basis,
      availability:'AVAILABLE',limitations:[],columns,rows:data.changes,total:data.changes.length}],
  };
}
// Retained generations still support the original paged detail endpoint.
function pageDetails(dataset,offset,limit) {
  const changes=dataset.sections.find(s=>s.id==='changes').rows.slice(offset,offset+limit);
  const fields=dataset.sections.find(s=>s.id==='fields').rows;
  return Object.fromEntries(changes.map(c=>[c.changeId,fields.filter(f=>f.changeId===c.changeId)]));
}
module.exports={read,pageDetails};
