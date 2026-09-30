// Patient report adapter: SQL owns temporal evidence, filters, links and totals.
// This module supplies display metadata and slices already-generated detail only.
const c=(key,label,type='text')=>({key,label,type});
const identity=[c('boundary','Handover boundary','datetime'),c('patientId','Patient identifier','identifier'),c('encounterId','Encounter ID','identifier')];
const columns={
  patients:[...identity,c('patientRecordId','Patient record ID','identifier'),c('encounter','Encounter number','identifier'),c('patientName','Patient (current identity)'),
    c('unit','Unit'),c('room','Room'),c('bed','Bed'),c('basis','Evidence basis','status'),c('cohortAt','Patient evidence cutoff','datetime'),
    c('incomingShift','Selected incoming shift'),c('incomingStart','Incoming approved start','datetime'),c('incomingEnd','Incoming approved end','datetime'),
    c('incomingState','Incoming responsibility evidence','status'),c('incomingStaff','Incoming published staff'),c('incomingAssignmentIds','Incoming allocation IDs','identifier'),
    c('outgoingShift','Selected outgoing shift'),c('outgoingStart','Outgoing approved start','datetime'),c('outgoingEnd','Outgoing approved end','datetime'),
    c('outgoingState','Outgoing responsibility evidence','status'),c('outgoingStaff','Outgoing published staff'),c('outgoingAssignmentIds','Outgoing allocation IDs','identifier'),
    c('clinicalStatus','Recorded clinical status','status'),c('summary','Recorded condition summary'),c('statusEffectiveAt','Status effective time','datetime'),c('statusRecordedAt','Status recording time','datetime'),
    c('assessmentId','Assessment ID','identifier'),c('acuity','Recorded acuity','status'),c('acuityLevelId','Acuity level ID','identifier'),c('score','Recorded score','number'),
    c('workload','Workload points','number'),c('adtBurden','ADT burden','number'),c('ruleSet','Frozen rule set / version'),
    c('assessedAt','Assessment effective time','datetime'),c('assessmentRecordedAt','Assessment recording time','datetime'),c('assessmentAgeHours','Assessment age (hours)','number'),c('exceptions','Evidence gaps / exceptions')],
  factors:[...identity,c('factorRecordId','Factor record ID','identifier'),c('factorId','Definition ID','identifier'),c('factor','Configured factor'),c('code','Factor code'),
    c('value','Recorded value','number'),c('effectiveAt','Effective from','datetime'),c('endedAt','Effective until (exclusive)','datetime'),c('recordedAt','Recorded at','datetime'),c('notes','Recorded notes'),c('evidence','Evidence basis')],
  events:[...identity,c('eventId','Canonical event ID','identifier'),c('kind','Event category','status'),c('title','Recorded event'),c('effectiveAt','Event / publication time','datetime'),
    c('recordedAt','Recording time','datetime'),c('value','Recorded value','number'),c('previousStaff','Previous staff (current identity)'),c('newStaff','New staff (current identity)'),c('notes','Recorded notes / change reason'),c('evidence','Evidence basis')],
  issues:[...identity,c('issueId','Issue ID','identifier'),c('eventId','Lifecycle evidence ID','identifier'),c('reason','Recorded reason'),c('severity','Recorded severity','status'),
    c('state','State at evidence cutoff','status'),c('title','Linked issue title'),c('detail','Recorded issue summary'),c('recordedAt','Lifecycle event time','datetime'),c('source','Source kind'),c('association','Association evidence')],
};
const temporalFields=['room','bed','encounterIds','incomingStaffId','outgoingStaffId','acuityLevelId','clinicalStatus'];
const limitations=[
  'Retrospective effective state retained at generation, not everything known to staff then. Backdated states, factors and assessments may be included; effective and recording times remain separate. Future assessments and ended factors are excluded from the cohort cutoff.',
  'Future handovers show the generation-time patient baseline and currently published plan, not confirmed future presence or outcomes. Expected discharge is not actual discharge. No future events or future clinical state are invented.',
  'Patient/staff identities and configured factor/event labels are current labels. Scores, acuity and rule version come from the applicable frozen assessment. Numeric factor values have their configured meaning; zero or absence is not a reassuring clinical negative.',
  'Only one unambiguous effective unit location establishes cohort membership. Missing/overlapping location history is omitted and counted separately before patient filters; current room/status never substitutes for missing historical evidence. Current retained admission/discharge corrections may affect retrospective presence.',
  'Approved contexts use actual retained assignment times, including overnight intervals. Contexts are roster evidence, not attendance. Responsibility requires applicable published allocation evidence; drafts and generated proposals never count. Publication is not a handover signature or receipt.',
  'Recent events use the selected outgoing start through the evidence cutoff (both endpoints included), or the preceding 24 hours if no outgoing context is selected. Only events with an unambiguous location in this authorized unit at event time are included; missing historical location can omit events. A future-only window is unavailable.',
  'Flow record IDs and publication-history IDs are separate canonical events. Admission/discharge facts and operation-audit rows are not unioned, preventing duplicate representations. Current flow active flags lack historical correction evidence and are labelled; publication time is not the shift effective time.',
  'Linked issues require immutable ACTIVE evidence at the cutoff plus explicit encounter association and matching organization/unit/shift context. Unit-wide issues, drafts, unknown associations and pre-bridge lifecycle gaps are not attached to patients. An empty linked-issue list is not proof of no unresolved problem.',
  'Assessment age is factual with no expiry threshold. Overlapping active factor values remain visible and flagged. No diagnoses, medication, allergy, observation, pending-task or received-by sections are inferred.',
];
async function lookup(client,{actor,field,parameters,search='',offset=0,value=null}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_patient_lookups($1,$2,$3::jsonb,$4,$5,$6) value',[actor,field,parameters,search,offset,value]);
  return rows[0].value;
}
async function read(client,{actor,parameters}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_patient_sheet($1,$2::jsonb) value',[actor,parameters]);
  const d=rows[0].value;
  const notes={patients:[limitations[3],limitations[4]],factors:[limitations[2],'No active recorded factor values does not establish absence of care needs.'],events:[limitations[5],limitations[6]],issues:[limitations[7]]};
  const titles={patients:'Patient Summary',factors:'Care Factors',events:'Recent Events',issues:'Linked Issues'};
  const grains={patients:'encounter at one boundary',factors:'effective factor record per encounter/boundary',events:'flow/publication record per encounter/boundary',issues:'explicit encounter/issue link at cutoff'};
  return {rowGrain:'One encounter at one selected handover boundary; patient identifiers and encounter identifiers are distinct.',patientContext:d.context,totals:d.totals,
    summaries:[
      {label:'Selected encounters',value:d.totals.patients,availability:'AVAILABLE',definition:'Matching documented boundary cohort; not a full unit total when filters are applied.'},
      {label:'Without incoming publication',value:d.totals.withoutIncoming,availability:'AVAILABLE',definition:'No applicable published incoming allocation in retained evidence.'},
      {label:'Incoming evidence incomplete',value:d.totals.unknownIncoming,availability:'AVAILABLE',definition:'Cannot establish responsibility from retained evidence.'},
      {label:'Assessment not recorded',value:d.totals.missingAssessment,availability:'AVAILABLE',definition:'No applicable assessment at the patient evidence cutoff.'},
      {label:'Location evidence gaps',value:d.totals.omittedLocation,availability:'AVAILABLE',definition:'Potential unit encounters omitted before patient filters; current location not substituted.'},
    ],sourceLimitations:limitations,metricDefinitions:[
      {id:'grain',label:'Encounter cohort',definition:'Distinct admitted, not actually discharged encounters with exactly one effective location in the selected unit. Future targets use min(boundary, generation time); filters apply to this evidence, not current mutable location/status.'},
      {id:'responsibility',label:'Published responsibility',definition:'Incoming at the target boundary; outgoing immediately before min(outgoing end, boundary). Separate absent, insufficient and context-not-selected states. Staff filters match only established published responsibility.'},
      {id:'assessment',label:'Assessment and factors',definition:'Latest effective assessment at cutoff, deterministic assessed_at / ID order, frozen rule/version. Factors use effective_at <= cutoff < ended_at (or open end); recording times expose retrospective entries.'},
      {id:'events',label:'Recent window',definition:'Outgoing start to patient evidence cutoff inclusive, or prior 24 hours. Flow and PUBLISHED history only; generation/proposals excluded. Future-only windows unavailable.'},
      {id:'issues',label:'Patient-linked issues',definition:'Latest immutable lifecycle evidence per issue at cutoff, ACTIVE with explicit encounter IDs or recorded patient care-change association. No count/title inference; linked groups can refer to several patients.'},
      {id:'time',label:'Time evidence',definition:'Configured business timezone and explicit output offsets. Legacy timestamps without offsets cannot distinguish ambiguous DST-fold occurrences. Retrospective effective evidence does not prove what the team knew then.'},
    ],sections:Object.keys(columns).map(id=>({id,title:titles[id],grain:grains[id],evidenceBasis:'MIXED',
      availability:id==='events'?d.context.recentAvailability:'AVAILABLE',limitations:notes[id],columns:columns[id],rows:d[id],total:d[id].length}))};
}
function pageDetails(dataset,offset,limit) {
  const patients=dataset.sections.find(s=>s.id==='patients').rows.slice(offset,offset+limit);
  // Presentation joins on server-produced stable IDs, never new clinical filtering.
  return Object.fromEntries(patients.map(p=>[p.encounterId,Object.fromEntries(dataset.sections.filter(s=>s.id!=='patients').map(s=>[s.id,s.rows.filter(r=>r.encounterId===p.encounterId)]))]));
}
module.exports={read,lookup,pageDetails,temporalFields};
