// SQL owns cohort, temporal selection, counts and ordering. This adapter only
// supplies typed presentation metadata for the shared immutable result contract.
const column=(key,label,type='text')=>({key,label,type});
const boundary=column('boundary','Boundary','datetime');
const columns={
  overview:[boundary,column('basis','Evidence basis','status'),column('measure','Measure'),column('value','Value','number'),column('definition','Definition')],
  distributions:[boundary,column('category','Category'),column('label','Recorded category / rule version'),column('count','Encounters','number')],
  patients:[boundary,column('unit','Unit'),column('evidenceBasis','Cohort basis','status'),column('cohortAt','Cohort evidence cutoff','datetime'),column('patientId','Patient identifier','identifier'),column('encounterId','Encounter ID','identifier'),
    column('encounter','Encounter number','identifier'),column('patientName','Patient (current identity)'),column('room','Room'),column('bed','Bed'),
    column('clinicalStatus','Recorded clinical status','status'),column('summary','Recorded summary'),column('acuity','Recorded acuity','status'),
    column('ruleSet','Rule set / version'),column('score','Score','number'),column('workload','Workload points','number'),
    column('assessedAt','Assessment effective time','datetime'),column('assessmentRecordedAt','Assessment recording time','datetime'),
    column('assessmentAgeHours','Assessment age (hours)','number'),column('incomingState','Incoming allocation evidence','status'),
    column('incomingStaff','Incoming published staff'),column('outgoingState','Outgoing allocation evidence','status'),column('outgoingStaff','Outgoing published staff'),
    column('incomingAssignmentIds','Incoming allocation IDs','identifier'),column('outgoingAssignmentIds','Outgoing allocation IDs','identifier'),column('exceptions','Documented exceptions')],
  movements:[boundary,column('eventId','Canonical movement ID','identifier'),column('eventType','Movement','status'),column('encounterId','Encounter ID','identifier'),
    column('effectiveAt','Effective time','datetime'),column('recordedAt','Source recording/update time','datetime'),column('evidence','Evidence')],
  exceptions:[boundary,column('priority','Priority','status'),column('status','Evidence status','status'),column('title','Finding'),column('detail','Recorded detail'),
    column('encounterId','Encounter ID','identifier'),column('source','Source'),column('sourceId','Source record ID','identifier'),column('recordedAt','Recorded time','datetime')],
};
const limitations=[
  'Retrospective clinical evidence uses retained effective dates as recorded at generation; later corrections may be included. It is not a reconstruction of everything known to staff at the time.',
  'Patient names/identifiers and unit labels are current identity labels. Clinical state, location and assessments come from effective history; missing history is never replaced with current location/status.',
  'Approved context choices reflect the retained roster at generation. Changed/deleted historical roster contexts cannot prove historical scheduling. Published allocation evidence uses frozen approved intervals when available; neither scheduling nor publication proves attendance or handover receipt.',
  'Movements count encounter admission/actual-discharge facts and unambiguous touching location transitions. Standalone flow/audit events, ambiguous/unlocated transitions and expected discharges are not added; their sources lack a reliable shared movement identity. Counts describe documented events, not unique patients or exhaustive movement capture.',
  'Known unresolved findings use lifecycle event evidence at the cutoff, with pre-bridge live-event fallback. No events does not prove healthy coverage. Older review lifecycle gaps are listed explicitly; no detector, acknowledgment or recalculation runs.',
  'Occupancy is omitted: configured beds have no matched historical inventory evidence. Assessment age has no invented expiry threshold; acuity is grouped by frozen rule set/version and scores are not averaged.',
  'Each date is a separate unit/boundary cohort. Patient-boundary rows and repeated movement windows must not be summed as unique patients/events across a range.',
];
async function read(client,{actor,parameters}) {
  const {rows}=await client.query('SELECT shiftly_api.fn_handover_unit_summary($1,$2::jsonb) value',[actor,parameters]);
  const data=rows[0].value;
  const section=(id,title,grain,notes)=>({id,title,grain,evidenceBasis:'MIXED',availability:id==='movements'?data.movementAvailability:'AVAILABLE',limitations:notes,
    columns:columns[id],rows:data[id],total:data[id].length});
  return {
    rowGrain:'One unit at one incoming approved boundary; each date remains a separate group.',
    boundarySummaries:data.boundaries,totals:data.totals,
    summaries:[{label:'Boundary groups',value:data.totals.boundaries,availability:'AVAILABLE',definition:'Each has a separate census and outgoing movement interval.'}],
    metricDefinitions:[
      {id:'census',label:'Documented census',definition:'Distinct encounters admitted and not actually discharged at the cohort cutoff, with exactly one applicable authorized unit location. Future target uses the generation-time baseline.'},
      {id:'assignments',label:'Allocation coverage',definition:'Published / without applicable retained publication / insufficient evidence are disjoint cohort categories. Drafts do not count. Outgoing responsibility is evaluated immediately before the earlier of outgoing end and boundary.'},
      {id:'movements',label:'Outgoing movements',definition:'Half-open [outgoing start, min(outgoing end, incoming start)). Count only elapsed recorded portion at generation; future-only interval is unavailable, not zero. Canonical identities: encounter admission/discharge, or old/new location IDs.'},
      {id:'time',label:'Time and range',definition:'All instants carry offsets in the configured business timezone. Naive historic timestamps inherit that zone; ambiguous DST-fold occurrences cannot be distinguished without recorded offsets. Per-boundary census is not additive.'},
      {id:'assessment',label:'Assessment evidence',definition:'Latest effective assessment selected independently per encounter. Frozen category/rule version, score and workload retained; age is elapsed hours to cohort cutoff.'},
      {id:'issues',label:'Known unresolved observations',definition:'Latest immutable Attention evidence per issue as of cutoff; explicit aliases/members are suppressed only with matching saved grouping evidence. Older live incidents use event state when no bridge event exists. Current OPEN flags are not historical proof.'},
    ],sourceLimitations:limitations,
    sections:[
      section('overview','Overview','measure per unit/boundary',['Future groups describe the current recorded plan and baseline; they do not confirm future census.']),
      section('distributions','Acuity and status','recorded category per unit/boundary',['Categories retain rule-set/version; missing categories are explicit.']),
      section('exceptions','Exceptions','documented exception per boundary',['Known observations, evidence gaps and patient exceptions are different records, not a newly calculated Attention total.']),
      section('patients','Patient Roster','encounter per boundary',['Current identity labels; historical clinical fields only where retained. A missing allocation is not proof of handover non-receipt.']),
      section('movements','Movements','canonical event per outgoing interval',[limitations[3],'Future-only intervals are unavailable; elapsed intervals with no matching records contain zero documented events.']),
    ],
  };
}
module.exports={read};
