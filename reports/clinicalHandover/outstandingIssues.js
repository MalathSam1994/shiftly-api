// Report-owned adapter: SQL owns scope, canonical identity and lifecycle evidence.
const c=(key,label,type='text')=>({key,label,type});
const columns={
 issues:[c('issueId','Canonical issue ID','identifier'),c('issueKey','Canonical key','identifier'),c('title','Issue'),c('domain','Domain','status'),c('category','Source category','status'),
  c('reason','Recorded reason','status'),c('severity','Severity','status'),c('state','State','status'),c('stateBasis','State evidence basis'),c('unit','Unit / scope'),c('organization','Organization'),
  c('divisionId','Division ID','identifier'),c('departmentId','Department ID','identifier'),c('unitId','Unit ID','identifier'),c('shiftDate','Shift start date','date'),c('shift','Shift'),
  c('shiftStart','Recorded shift start','datetime'),c('shiftEnd','Recorded shift end','datetime'),c('firstDetected','First detection','datetime'),c('lastChanged','Last meaningful change / snapshot','datetime'),
  c('snapshotAt','Last captured Attention event','datetime'),c('lastChecked','Last stored check / historical snapshot','datetime'),c('lastResolved','Last recorded resolution','datetime'),c('lastReopened','Last recorded reopening','datetime'),
  c('episodeStart','Episode observation start','datetime'),c('openMinutes','Observed episode duration (minutes)','number'),c('durationBasis','Duration basis'),c('acknowledgment','Recorded acknowledgment / review'),
  c('linkedSources','Linked original source identities'),c('observationIds','Underlying Attention observation IDs','identifier'),c('association','Direct-link classification','status'),
  c('summary','Recorded explanation'),c('evidence','Recorded evidence'),c('target','Existing destination','status'),c('actionAvailable','Current-context action permitted','status')],
 sources:[c('issueId','Canonical issue ID','identifier'),c('sourceKey','Source key','identifier'),c('kind','Source kind','status'),c('sourceId','Source ID','identifier'),c('state','Recorded source state','status'),
  c('snapshotAt','Source snapshot time','datetime'),c('action','Recorded action meaning'),c('actionAt','Acknowledgment / review time','datetime'),c('actorId','Recorded actor ID','identifier'),c('actor','Recorded actor (current label)'),
  c('gapStart','Recorded gap start','datetime'),c('gapBasis','Gap start basis','status'),c('gapMinutes','Single-episode observed gap minutes','number'),c('evidence','Source evidence')],
 lifecycle:[c('issueId','Canonical issue ID','identifier'),c('eventKey','Immutable event key','identifier'),c('source','Source event stream','status'),c('sourceId','Original source ID','identifier'),
  c('event','Recorded event','status'),c('recordedAt','Recording / detection time','datetime'),c('actorId','Actor ID','identifier'),c('actor','Recorded actor (current label)'),c('state','Explicit event state','status'),c('evidence','Captured evidence')],
 associations:[c('issueId','Canonical issue ID','identifier'),c('observationId','Original Attention observation ID','identifier'),c('kind','Direct association','status'),c('recordId','Encounter / staff record ID','identifier'),
  c('name','Current authorized display name'),c('encounter','Encounter number','identifier'),c('patientId','Patient identifier','identifier'),c('basis','Association basis')],
 gaps:[c('sourceKey','Original source key','identifier'),c('kind','Evidence gap','status'),c('sourceId','Original source ID','identifier'),c('recordedAt','Known detection / capture time','datetime'),c('limitation','Missing evidence'),c('basis','Population / counting basis')],
};
const limitations=[
 'This is the stored canonical Attention projection, not a new operational evaluation. No reconciliation, acknowledgment, optimization, publication or notification delivery runs. Stored detection reflects operational horizons; missing/stale saved evidence cannot prove there are no issues outside them.',
 'One primary Attention issue counts once. Explicit grouped observations retain their IDs/evidence in detail; workflow and coverage events are supporting sources, not additional issues. Multiple independent reasons on one incident/workflow remain separate canonical issues.',
 'Historical state uses the last immutable Attention snapshot at or before the reference, plus captured-interval expiry. Source predicates, silent metadata/group-link changes and acknowledgment inputs are not fully audited. Historical unresolved totals are unavailable as a complete census; shown rows are last recorded states, with explicit evidence gaps.',
 'Historical grouping uses captured consolidated_into_key or the established exact-scope staff-group identity with an existing parent snapshot. Current grouping is not projected backward without evidence. Missing parent evidence is excluded from primary counts and disclosed.',
 'Reference is a point-in-time population and retains earlier detections. No interval-activity mode or first-detected-during filter is applied. Future handover shows current recorded issues relevant to that context, not a prediction of which problems will remain unresolved.',
 'Open duration is one observed episode, reset by a recorded reopening. Detection is not gap onset. Coverage gap minutes respect FIRST_OBSERVED (since detection), PATIENT_ARRIVAL or SCHEDULED_END; unknown basis or missing end stays unavailable. Episodes and overlapping sources are never summed.',
 'Acknowledgment, review, publication and notification reading remain distinct from resolution. Source detail preserves the most recent recorded acknowledgment even if later findings require review again. Notified managers are not owners; no owner, due date, clinical follow-up task or plan is invented.',
 'Direct patient/staff links use recorded typed IDs only. Unit-wide findings are not copied onto every patient. Labels may be current; moved/inaccessible patient names remain unavailable. Unknown actors are not inferred from notification recipients.',
 'Source events are scoped to the recorded organization and authorized again. A shared source event can appear under several independent canonical issues; lifecycle rows are evidence records, not unique-issue counts. Unrepresented sources are evidence gaps, not newly invented canonical alerts.',
 'Scope-wide gaps are independent of reason/severity/lifecycle filters and remain separate from selected canonical counts. Current-source functions are not used to reconstruct historical states. Legacy wall timestamps use business timezone; missing original DST offsets cannot be recovered.',
];
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_outstanding_issues($1,$2::jsonb) value',[actor,parameters]);const d=rows[0].value;
 const section=(id,title,grain,notes)=>({id,title,grain,evidenceBasis:d.context.historical?'HISTORICAL':'CURRENT',availability:'AVAILABLE',columns:columns[id],rows:d[id],total:d[id].length,limitations:notes});
 const metric=(label,key,definition)=>({label,value:d.totals[key],availability:'AVAILABLE',definition});
 return {rowGrain:'One canonical primary Attention issue; sources, lifecycle events and direct links are supporting detail.',issueContext:d.context,categorySummaries:d.categories,totals:d.totals,
  summaries:[metric(d.context.historical?'Captured issue states':'Canonical issues','issues','Selected primary identities; not underlying observations or source events.'),
   metric(d.context.historical?'Last recorded active':'Recorded active','active','Includes earlier unresolved detections. Historical rows are partial captured evidence, not a complete past census.'),
   metric('Critical','critical','Selected primary issues with recorded CRITICAL severity.'),metric('Warning','warning','Selected primary issues with recorded WARNING severity.'),
   metric('Direct patient-linked issues','patientLinked','Issues with explicit encounter identifiers; scope-only issues remain separate.'),metric('Scope evidence gaps','historyGaps','Separate authorized source/history limitations; excluded from primary issue totals.')],
  metricDefinitions:[{id:'canonical',label:'Issue count',definition:limitations[1]},{id:'historical',label:'Historical completeness',definition:limitations[2]},
   {id:'duration',label:'Observed duration',definition:limitations[5]},{id:'ack',label:'Acknowledgment',definition:limitations[6]}],sourceLimitations:limitations,
  sections:[section('issues','Issues','canonical primary issue',[limitations[0],d.context.historical?limitations[2]:limitations[1]]),
   section('sources','Source Detail','canonical issue / explicitly linked source',[limitations[5],limitations[6]]),
   section('lifecycle','Lifecycle Detail','immutable event / canonical issue',[limitations[8]]),
   section('associations','Direct Links','canonical issue / observation / typed encounter or user link',[limitations[7]]),
   section('gaps','Evidence Gaps','unrepresented or uncaptured source',[limitations[9]])]};
}
async function lookup(client,{actor,parameters,search='',offset=0,value=null}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_issue_reasons($1,$2::jsonb,$3,$4,$5) value',[actor,parameters,search,offset,value]);return rows[0].value;
}
function pageDetails(data,offset,limit) {
 const ids=new Set(data.sections.find(s=>s.id==='issues').rows.slice(offset,offset+limit).map(r=>r.issueId));
 return Object.fromEntries(['sources','lifecycle','associations'].map(id=>[id,data.sections.find(s=>s.id===id).rows.filter(r=>ids.has(r.issueId))]));
}
module.exports={read,lookup,pageDetails};
