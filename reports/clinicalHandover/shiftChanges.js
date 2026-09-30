// Report adapter only: PostgreSQL owns interval selection, predecessors, scope,
// explicit source links, field comparisons and distinct encounter/change counts.
const c=(key,label,type='text')=>({key,label,type});
const columns={
  changes:[c('changeId','Stable change ID','identifier'),c('patientId','Patient identifier','identifier'),c('encounterId','Encounter ID','identifier'),
    c('encounter','Encounter number','identifier'),c('patientName','Patient (current identity)'),c('categories','Categories'),c('title','Recorded change'),
    c('origin','Origin / event location'),c('destination','Destination / event location'),c('direction','Transfer direction'),
    c('effectiveAt','First included effective / publication time','datetime'),c('lastEffectiveAt','Last included effective / publication time','datetime'),
    c('recordedAt','First known recording time','datetime'),c('actor','Recorded actor(s)'),c('actorIds','Actor IDs','identifier'),
    c('source','Source references','identifier'),c('fieldCount','Included changed fields','number'),c('before','Before'),c('after','After'),
    c('reason','Recorded reasons / notes'),c('evidenceStatus','Evidence status','status')],
  fields:[c('changeId','Parent change ID','identifier'),c('fieldId','Stable field ID','identifier'),c('patientId','Patient identifier','identifier'),c('encounterId','Encounter ID','identifier'),
    c('category','Category'),c('field','Changed field'),c('before','Before (display)'),c('after','After (display)'),
    c('beforeNumber','Before numeric value','number'),c('afterNumber','After numeric value','number'),
    c('effectiveAt','Effective / publication time','datetime'),c('recordedAt','Recording time','datetime'),c('timeBasis','Time semantics','status'),
    c('actor','Recorded actor'),c('actorId','Actor ID','identifier'),c('source','Source reference','identifier'),c('reason','Recorded reason / notes'),
    c('previousEvidence','Previous-value evidence','status'),c('evidence','Source evidence / limitation')],
};
const limitations=[
  'Retrospective retained effective history, recorded by generation; later backdated corrections may appear. This is not a claim about everything known to the team then. Patient, staff and organization names are current identity labels.',
  'One top-level row per evidenced source change. Exactly linked audit/assessment records share an operation ID; state/factor/location fallback records are excluded only by explicit record links. Category totals overlap when one operation changes several categories; do not sum them as unique events.',
  'Legacy flow records have no shared operation ID with ADT audit. They remain separately labelled FLOW_RECORD evidence and may describe the same occurrence as a movement or assessment. The report does not claim a unique real-world event total.',
  'Clinical/flow fields use effective time; published responsibility fields use recorded publication time. Intervals are half-open. Both field timestamps remain available; future portions contain no predicted events. Legacy wall timestamps inherit business timezone and cannot disambiguate DST-fold occurrences.',
  'Predecessors are searched before each event, including before the requested interval. Missing previous values are explicit, not zero/normal. Overlapping predecessor state/factor evidence is unavailable; gaps do not establish continuous condition. Unchanged stored reassessments and same-value replacement records are omitted.',
  'Assessment scores/levels/workload/ADT and rule version are retained values. Rule changes are neutral configuration evidence, not inferred clinical deterioration/improvement. No clinical score is recalculated.',
  'Movement facts use actual admission/discharge and retained old/new locations, never expected discharge. A unique touching location pair produces one transfer, with origin/destination and direction relative to scope. Audit movement uses its explicit snapshots. Corrected mutable encounter facts cannot reconstruct knowledge at that time.',
  'Event-time location must be evidenced and authorized. Missing or ambiguous location can omit a change; current location is never substituted. Counterpart location details outside current access are redacted. No rows is not proof that nothing happened.',
  'Fallback factor ending/discharge records lack exact recording time and actor; these remain unavailable. Flow active flags are current metadata, not reconstructed historical correction state. Factor labels are current configured definitions; no fixed medical checklist is used.',
  'Only PUBLISHED assignment history participates. Draft generation/manual proposal activity is omitted. Publication is recorded responsibility, not attendance or handover receipt; deleted identity links remain unknown.',
];
async function lookup(client,{actor,field,parameters,search='',offset=0,value=null}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_changes_lookups($1,$2,$3::jsonb,$4,$5,$6) value',[actor,field,parameters,search,offset,value]);
  return rows[0].value;
}
async function read(client,{actor,parameters}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_shift_changes($1,$2::jsonb) value',[actor,parameters]);
  const d=rows[0].value,available=d.context.availability==='AVAILABLE';
  const metric=(label,key,definition)=>({label,value:available?d.totals[key]:null,availability:d.context.availability,definition});
  return {rowGrain:'One evidenced source change, with field-level children; linked audit and assessment share an operation ID.',
    changeContext:d.context,categorySummaries:d.categories,totals:d.totals,authorizationPairs:d.scopePairs,
    summaries:[metric('Changed encounters','changedEncounters','Distinct encounter IDs, not event count or unique lifetime patients.'),
      metric('Evidenced source changes','changes','Explicitly linked representations grouped; unlinked flow records remain separate.'),
      metric('Incomplete predecessors','incompletePredecessors','A prior value is missing for at least one included changed field.'),
      metric('Rule/version changes','ruleChanges','Neutral assessment configuration changes; no clinical direction inferred.')],
    sourceLimitations:limitations,metricDefinitions:[
      {id:'interval',label:'Interval',definition:'Business dates include the last selected day by ending at next midnight. Exact timestamps include offsets. All filtering uses [start,end); only elapsed recorded evidence is included.'},
      {id:'grain',label:'Change identity',definition:'Operation ID groups directly linked assessment changes. Otherwise stable state/factor/location/encounter/flow/publication source IDs identify rows. No title/time/count-based merging.'},
      {id:'patients',label:'Changed patients',definition:'Count DISTINCT encounter_id in selected evidenced changes. Repeated events for one encounter do not inflate it; repeat encounters remain distinct.'},
      {id:'categories',label:'Category and actor filters',definition:'Filters select included field-source records before grouping. An operation can belong to multiple categories; category changes/encounters are distinct within each category and not additive.'},
      {id:'previous',label:'Before and after',definition:'Retained audit snapshots or the prior applicable effective record, including records before the interval. Missing values remain unavailable; unchanged stored values do not create a change solely due to a new row.'},
      {id:'transfer',label:'Transfers',definition:'One source change per explicit audit operation or unambiguous touching location pair. One all-scope row retains both endpoints; unit scope labels in/out. Unlinked flow records are a separate category, not unique transfer totals.'},
    ],sections:[{id:'changes',title:'Changes',grain:'evidenced source change',evidenceBasis:'HISTORICAL',availability:d.context.availability,
      limitations:[limitations[1],limitations[2],limitations[7]],columns:columns.changes,rows:d.changes,total:d.changes.length},
      {id:'fields',title:'Field Changes',grain:'changed field linked to source change',evidenceBasis:'HISTORICAL',availability:d.context.availability,
      limitations:[limitations[3],limitations[4]],columns:columns.fields,rows:d.fields,total:d.fields.length}]};
}
function pageDetails(dataset,offset,limit) {
  const changes=dataset.sections.find(s=>s.id==='changes').rows.slice(offset,offset+limit);
  const fields=dataset.sections.find(s=>s.id==='fields').rows;
  return Object.fromEntries(changes.map(c=>[c.changeId,fields.filter(f=>f.changeId===c.changeId)]));
}
module.exports={read,lookup,pageDetails};
