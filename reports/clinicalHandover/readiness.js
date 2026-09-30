// Report-owned adapter. All eligibility/counting/temporal selection stays in SQL.
const c=(key,label,type='text')=>({key,label,type});
const columns={
 overview:[c('measure','Measure'),c('value','Value','number'),c('definition','Denominator / evidence basis')],
 requirements:[c('groupId','Capacity group','identifier'),c('periodId','Period','identifier'),c('staffType','Staff type'),c('required','Required places','number'),
  c('occupied','Occupied roster places','number'),c('approved','Approved working rows','number'),c('eligible','Clinically eligible users','number'),
  c('unfilled','Roster places unfilled','number'),c('eligibleDeficit','Eligible coverage deficit','number'),c('status','Recorded approval state','status'),c('pendingRequired','Pending requirement (not applied)','number'),c('basis','Requirement basis')],
 staff:[c('assignmentId','Roster assignment','identifier'),c('userId','Staff ID','identifier'),c('employee','Employee number','identifier'),c('staff','Scheduled staff'),c('staffType','Staff type'),
  c('start','Actual start','datetime'),c('end','Actual end','datetime'),c('atReference','Interval contains reference','status'),c('eligibility','Eligibility','status'),c('reasons','Recorded eligibility reasons'),
  c('recordedAbsences','User absence records'),c('validCompetencies','Valid competencies'),c('requiredCompetencies','Required competencies / sources'),c('missingCompetencies','Missing competencies'),
  c('policyId','Capacity policy ID','identifier'),c('policy','Capacity policy'),c('scope','Scope / basis')],
 patients:[c('encounterId','Encounter ID','identifier'),c('encounter','Encounter number','identifier'),c('patientId','Patient identifier','identifier'),c('patient','Patient'),c('room','Current room'),c('bed','Current bed'),
  c('acuity','Recorded acuity'),c('ruleSet','Rule set / version'),c('workload','Recorded workload','number'),c('assessedAt','Assessment effective time','datetime'),
  c('allocation','Published allocation evidence','status'),c('staff','Published responsible staff'),c('assignmentIds','Patient assignment IDs','identifier'),c('assignedStaffEligible','Assigned staff eligible','status'),c('reviewNotes','Recorded review notes'),c('basis','Planning basis')],
 competencies:[c('assignmentId','Roster assignment','identifier'),c('userId','Staff ID','identifier'),c('staff','Affected staff'),c('competencyId','Competency ID','identifier'),c('competency','Required competency'),
  c('status','Why not valid','status'),c('mappingId','Representative mapping ID','identifier'),c('validFrom','Valid from','date'),c('validTo','Valid through (inclusive)','date'),c('requirementSources','Requirement sources'),c('basis','Validity convention')],
 capacity:[c('assignmentId','Roster assignment','identifier'),c('userId','Staff ID','identifier'),c('staff','Scheduled staff'),c('status','Capacity check','status'),c('policyId','Policy ID','identifier'),c('policy','Selected unit policy'),
  c('patients','Department-shared assigned patients','number'),c('maxPatients','Patient limit','number'),c('workload','Recorded shared workload','number'),c('maxWorkload','Workload limit','number'),
  c('highExtreme','High / extreme patients','number'),c('maxHighExtreme','High / extreme limit','number'),c('extreme','Extreme patients','number'),c('recordedMaxExtreme','Extreme-only policy metadata','number'),
  c('unassessed','Patients with incomplete assessment','number'),c('sharedUnits','Units sharing this load'),c('encounterIds','Affected encounter IDs','identifier'),c('utilization','Workload utilization (%)','number'),c('basis','Capacity basis')],
 pending:[c('key','Source key','identifier'),c('kind','Source kind','status'),c('sourceId','Source ID','identifier'),c('status','Recorded / compared state','status'),c('summary','Summary'),c('reasons','Reasons / notes'),
  c('checkedAt','Saved last checked / updated','datetime'),c('runId','Proposal ID','identifier'),c('workflowId','Review workflow ID','identifier'),c('needsAction','Canonical review / saved incident needs attention','status'),c('basis','Scope / evidence basis')],
 findings:[c('key','Finding reference','identifier'),c('category','Category','status'),c('severity','Review priority','status'),c('title','Finding'),c('detail','Evidence / affected records'),
  c('assignmentId','Roster assignment','identifier'),c('encounterId','Encounter ID','identifier'),c('groupId','Capacity group','identifier'),c('workflowId','Workflow ID','identifier'),c('runId','Run ID','identifier'),
  c('destination','Existing application destination','status'),c('actionAvailable','Destination permission at generation','status')],
};
const limitations=[
 'Current recorded plan only. The patient baseline is the current ACTIVE/TRANSFERRED unit cohort used by canonical requirements, not a confirmed future census. Expected discharges, attendance and handover receipt are not predicted.',
 'Clinical eligibility/capacity policy and competency validity come from the canonical read-only staff pool on the target shift date. Its current patient factors/acuity inform requirements; this does not reconstruct historical readiness. Completed target shifts are rejected before evaluating current rules.',
 'Actual approved or planned roster intervals are retained. A requirement-only context without working roster uses labelled shift-type planning defaults, never a replacement for explicit approved times. Several actual contexts require explicit selection.',
 'Approved working rows/users, roster absence rows, user absence records, occupied places, clinical eligibility, minimum roster users and published patient allocations are separate measures. Minimum roster includes unapproved rows and uses existing distinct-department-user rules.',
 'Staff/requirements are department shared. Do not sum repeated unit reports. Capacity groups cover the entire period/date/type/staff-type, not each overridden time window, and are displayed separately without a combined invented requirement.',
 'Staff table covers approved non-absence rows overlapping the remaining target interval. Later starters are visible; reference-point counts are separate. This report does not guarantee continuous staffing through the end of the shift.',
 'Published allocations require retained identity and an applicable approved interval at the reference point. Ineligible staff can still have a recorded published allocation and remain an independent eligibility problem. Multiple/lost records are insufficient evidence, not automatic coverage.',
 "Capacity compares one scheduled row's published load across the authorized department with the selected-unit policy, including patients in other units. Missing/future-dated current assessment makes load incomplete. Unknown policies/zero limits never produce fabricated utilization. HIGH includes EXTREME as in canonical checks; extreme-only limit is metadata, not a new enforced rule.",
 'The optimizer hard-capacity setting is shown separately; reported configured-limit exceedances do not change operational enforcement. Existing role/date/competency and assignment rules remain unchanged.',
 'Pending review uses the canonical read-only needs-attention predicate. Proposals remain unpublished; stale-input comparison uses the canonical current scope hash without updating the run. A workflow and its linked proposal are related source records, not two guaranteed independent problems.',
 'Saved current live incidents are included only for a currently running target and keep their last-checked timestamp. No detector/refresh is run; stale or missing saved findings cannot prove healthy coverage.',
 'No blocking findings detected by these checks is not a guarantee of clinical safety, actual attendance, completed handover or future outcomes. Current display names and legacy wall timestamps use the configured business timezone; DST-fold ambiguity cannot be recovered without recorded offsets.',
];
async function lookup(client,{actor,parameters,search='',offset=0,value=null}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_readiness_lookup($1,$2::jsonb,$3,$4,$5) value',[actor,parameters,search,offset,value]);return rows[0].value;
}
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_incoming_readiness($1,$2::jsonb) value',[actor,parameters]);const d=rows[0].value;
 const summary=(label,key,definition)=>({label,value:d.totals[key],definition,availability:'AVAILABLE'});
 const section=(id,title,grain,notes)=>({id,title,grain,evidenceBasis:'MIXED',availability:'AVAILABLE',columns:columns[id],rows:d[id],total:d[id].length,limitations:notes});
 return {rowGrain:'One unit and explicit current/upcoming target context; department staffing is shared and non-additive across units.',
  readinessContext:d.context,totals:d.totals,
  summaries:[summary('Approved scheduled staff','scheduledUsers','Distinct users with approved working rows overlapping the remaining target window; department shared.'),
   summary('Clinically eligible staff','eligibleUsers','Distinct eligible users in that pool; reference-point coverage is separately labelled.'),
   summary('Published patient allocations','published',`${d.totals.patients} current-baseline encounters; not future census. ${d.totals.withoutPublished} without applicable publication; ${d.totals.unknownAllocation} insufficient evidence.`),
   summary('Competency findings','competencyFindings','Missing/invalid required competency per scheduled assignment; not distinct staff.'),
   summary('Capacity exceedances','capacityExceeded',`${d.totals.capacityUnknown} policy/load evidence gaps remain separate.`),
   summary('Outstanding reviews','reviews',`${d.totals.proposals} unpublished proposals, including ${d.totals.staleProposals} with stale inputs; related source records are not additive issues.`)],
  metricDefinitions:d.overview.map((r,i)=>({id:`readiness-${i}`,label:r.measure,definition:r.definition})),sourceLimitations:limitations,
  sections:[section('findings','Readiness Findings','recorded condition / affected source',['Report findings are not new Attention events; no lifecycle or acknowledgment changes.']),
   section('overview','Overview','explicit measure / denominator',[limitations[0],limitations[3]]),
   section('requirements','Staffing Requirements','department capacity group',[limitations[4]]),
   section('staff','Scheduled Staff','approved working roster assignment',[limitations[1],limitations[5]]),
   section('patients','Patient Coverage','current-baseline encounter',[limitations[0],limitations[6]]),
   section('competencies','Competency Findings','scheduled assignment / required competency',['valid_to is inclusive on target shift date. No invented expiry threshold; the representative invalid mapping explains a canonical missing competency.']),
   section('capacity','Capacity Findings','scheduled row and shared departmental published load',[limitations[7],limitations[8]]),
   section('pending','Pending Reviews','workflow / proposal / saved current incident',[limitations[9],limitations[10]])]};
}
module.exports={read,lookup};
