// Report-owned contract. No operational detector or monthly analytics dependency.
const OPEN = 'screen:clinical_analytics:open';
const EXPORT = 'action:clinical_analytics:export';
const PATIENT = 'screen:clinical_patient_administration:open';
const STAFF = 'screen:clinical_staff_pool:open';
const REVIEW = 'action:clinical_assignment_workflows:review';
const field = (label, type, semantics, extra = {}) => ({ label, type, semantics, ...extra });
const select = (label, lookup, semantics, dependsOn = [], access = []) =>
  field(label, 'lookup', semantics, { lookup, dependsOn, access });
const fields = {
  divisionId: select('Division / hospital', 'divisions', 'Authorized organization.'),
  departmentId: select('Department', 'departments', 'Division-qualified department.', ['divisionId']),
  unitId: select('Clinical unit', 'units', 'Unit and its actual organization; never inferred from a name.', ['divisionId', 'departmentId']),
  fromDate: field('From date', 'date', 'Inclusive first business date.', { default: 'TODAY' }),
  toDate: field('To date', 'date', 'Inclusive last business date; internal upper bound is next midnight.', { default: 'TODAY' }),
  intervalMode: field('Event interval', 'enum', 'Inclusive business dates or exact times with offsets; end is always exclusive internally.', {options:['BUSINESS_DATES','EXACT_TIMES']}),
  fromTime: field('From time (inclusive)', 'instant', 'Exact interval start, including UTC offset. Overnight intervals can cross business dates.', {dependsOn:['intervalMode']}),
  toTime: field('To time (exclusive)', 'instant', 'Exact interval end, including UTC offset. Events at this instant belong to the next interval.', {dependsOn:['intervalMode']}),
  changeCategory: field('Change category', 'enum', 'Selects matching evidenced fields within source changes; mixed operations can belong to multiple categories.', {options:['CLINICAL_STATUS','ACUITY','CARE_FACTOR','ADMISSION','DISCHARGE','TRANSFER','LOCATION','PUBLISHED_RESPONSIBILITY','FLOW_RECORD']}),
  issueTimeMode: field('Issue reference', 'enum', 'Now, an explicit reference instant, or the start of a selected approved handover context. Includes carried-over issues.', {options:['NOW','REFERENCE','HANDOVER']}),
  issueDomain: field('Issue domain', 'enum', 'Recorded domain; independent of time scope.', {options:['CLINICAL','SCHEDULING']}),
  issueCategory: field('Source category', 'enum', 'Canonical source category; linked observations do not become extra issues.', {options:['REVIEW','LIVE','MINIMUM_COVERAGE','STAFF_ELIGIBILITY_GROUP','STAFF_POOL','ROSTER','CURRENT_ASSIGNMENT','DRAFT','CENSUS']}),
  issueLifecycle: field('Recorded issue state', 'enum', 'ACTIVE defaults to unresolved recorded issues, including earlier detections. Historical evidence gaps remain separately visible.', {options:['ACTIVE','ALL','RESOLVED','HISTORICAL','EXPIRED','SUPERSEDED','UNAVAILABLE']}),
  referenceTime: field('Reference time', 'instant', 'Explicit ISO time with offset; blank uses generation reference time.'),
  shiftDate: field('Shift date', 'date', 'Business date on which the shift starts.', { default: 'TODAY' }),
  shiftTypeId: select('Shift type', 'shiftTypes', 'Catalog type only; never overrides recorded assignment times.', ['divisionId', 'departmentId', 'unitId']),
  shiftContextId: select('Shift context', 'shiftContexts', 'Explicit approved roster interval, period, date and shift. Scheduled, not attendance.', ['unitId', 'shiftDate', 'shiftTypeId'], [STAFF]),
  targetContextKey: select('Target shift context', 'readinessContexts', 'Current/upcoming actual roster interval; requirement-only defaults are explicitly labelled. One choice is never inferred from several contexts.', ['unitId','shiftDate','shiftTypeId'], [STAFF,PATIENT]),
  outgoingContextId: select('Outgoing shift', 'shiftContexts', 'Explicit outgoing approved roster context.', ['unitId', 'shiftDate'], [STAFF]),
  incomingContextId: select('Incoming shift', 'shiftContexts', 'Explicit incoming approved roster context; future means recorded plan.', ['unitId', 'shiftDate'], [STAFF]),
  room: select('Room', 'rooms', 'Recorded location label within the selected unit; not an inventory.', ['unitId'], [PATIENT]),
  bed: select('Bed', 'beds', 'Recorded bed label within the selected unit and room.', ['unitId', 'room'], [PATIENT]),
  encounterId: select('Patient / encounter', 'patients', 'Patient identity and distinct encounter, including retained location history.', ['unitId', 'room', 'bed'], [PATIENT]),
  assignedStaffId: select('Assigned staff', 'staff', 'Assigned staff identity; not recorded actor or reviewer.', ['divisionId', 'departmentId', 'unitId'], [STAFF]),
  encounterIds: {...select('Patients / encounters', 'patientBoundary', 'Select up to 100 encounters, or leave blank for all matching boundary records.', ['unitId','shiftContextId','room','bed'], [PATIENT]), multiple:true},
  incomingStaffId: select('Incoming published staff', 'patientBoundary', 'Filters evidenced published incoming responsibility, not scheduled staff or attendance.', ['unitId','shiftContextId'], [STAFF]),
  outgoingStaffId: select('Outgoing published staff', 'patientBoundary', 'Filters evidenced outgoing responsibility immediately before outgoing end or handover, whichever comes first.', ['unitId','shiftContextId','outgoingContextId'], [STAFF]),
  clinicalStatus: select('Recorded clinical status', 'patientBoundary', 'Effective clinical state at the cohort cutoff; not current encounter status.', ['unitId','shiftContextId'], [PATIENT]),
  actorId: select('Recorded actor', 'actors', 'User recorded on the event; not responsible nurse.', ['divisionId', 'departmentId', 'unitId'], [PATIENT]),
  reviewerId: select('Reviewer', 'reviewers', 'User recorded as reviewer; review is not receipt of handover.', ['divisionId', 'departmentId', 'unitId'], [REVIEW]),
  staffTypeId: select('Staff type', 'staffTypes', 'Declared staff category; metric denominators must be explicitly defined.'),
  acuityLevelId: select('Acuity level', 'acuityLevels', 'Recorded level, qualified by rule set. No invented expiry threshold.', ['unitId'], [PATIENT]),
  competencyId: select('Competency', 'competencies', 'Declared competency category; does not recalculate eligibility.', [], [STAFF]),
  patientStatus: field('Encounter status', 'enum', 'Recorded encounter status.', { options: ['ACTIVE','DISCHARGED','TRANSFERRED','CANCELLED'] }),
  eventType: field('Event category', 'enum', 'Recorded operation category, not inferred occurrence.', { options: ['CLINICAL_STATUS','FACTOR_VALUE','ADT_EVENT','PATIENT_UPSERT','ENCOUNTER_UPSERT'] }),
  issueReason: select('Issue reason', 'issueReasons', 'Recorded issue reason; no new detection.'),
  severity: field('Severity', 'enum', 'Recorded severity.', { options: ['CRITICAL','WARNING','INFO'] }),
  issueStatus: field('Issue status', 'enum', 'Recorded source lifecycle at the requested reference.', { options: ['ACTIVE','RESOLVED','EXPIRED','SUPERSEDED','UNAVAILABLE'] }),
  reviewStatus: field('Review status', 'enum', 'Workflow review/publication status; not handover receipt.', { options: ['OPEN','REVIEWED','OPTIMIZATION_REQUESTED','SKIPPED','PUBLISHED','CANCELLED','RESOLVED'] }),
};
const org = ['divisionId','departmentId','unitId'];
const section = (id, title, grain) => ({ id, title, grain });
const definition = (id, title, description, parameters, required, access, sections, groups, sorts, timeBasis) => ({
  id, title, description, parameters, required, access: [OPEN, ...access], sections,
  groupingOptions: groups, sortingOptions: sorts, defaults: { groupBy: groups[0], sortBy: sorts[0] },
  timeBasis, available: false, unavailableReason: 'The workspace is ready. This report dataset will be enabled in a later stage.',
});
const reports = [
  definition('unit_handover_summary','Unit daily summary','Patients and daily movements at the end of the selected date, or so far today.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF,REVIEW],
    [section('overview','Overview','measure per unit/day'),section('patients','Patients','encounter at the daily cutoff')],
    ['unit'],['location'], 'DAY_SNAPSHOT'),
  definition('patient_handover_sheet','Patient handover sheet','Patient condition and recorded care factors at the end of the selected date, or so far today.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF,REVIEW],
    [section('patients','Patients','encounter at the daily cutoff'),section('factors','Care factors','active recorded factor per encounter')],
    ['encounter'],['location'], 'DAY_SNAPSHOT'),
  definition('changes_since_previous_shift','Daily changes','Patient and published staff changes during the selected date, or so far today.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF],
    [section('changes','Changes','changed item during the selected day')], ['timeline'],['effectiveTime'], 'DAY_INTERVAL'),
  definition('incoming_shift_readiness','Incoming shift readiness','The recorded staffing and competency plan for a target shift.',
    [...org,'shiftDate','shiftTypeId','targetContextKey'], ['unitId','shiftDate','targetContextKey'], [PATIENT,STAFF,REVIEW],
    [section('findings','Readiness Findings','recorded condition / affected source'),section('overview','Overview','measure / denominator'),
     section('requirements','Staffing Requirements','department capacity group'),section('staff','Scheduled Staff','approved working roster assignment'),
     section('patients','Patient Coverage','current-baseline encounter'),section('competencies','Competency Findings','scheduled assignment / required competency'),
     section('capacity','Capacity Findings','shared departmental load / scheduled row'),section('pending','Pending Reviews','review / proposal / saved incident')],
    ['unit'],['staff','status'], 'TARGET_SHIFT'),
  definition('outstanding_handover_issues','Outstanding issues for the incoming shift','Carried-over canonical issues, recorded lifecycle and direct source evidence.',
    [...org,'issueTimeMode','referenceTime','shiftDate','shiftTypeId','shiftContextId','issueDomain','issueCategory','issueReason','severity','issueLifecycle'], ['issueTimeMode'], [PATIENT,STAFF,REVIEW],
    [section('issues','Issues','canonical primary issue'),section('sources','Source Detail','linked source / issue'),section('lifecycle','Lifecycle Detail','recorded event / issue'),
     section('associations','Direct Links','explicit encounter or user link'),section('gaps','Evidence Gaps','uncaptured or unrepresented source')], ['priority','unit','reason'],['severity','firstDetected'], 'REFERENCE'),
  definition('workload_and_continuity','Workload balance and continuity of responsibility','Published workload, shared staff load and responsibility across two explicit shifts.',
    [...org,'shiftDate','shiftTypeId','outgoingContextId','incomingContextId','assignedStaffId','staffTypeId'], ['unitId','shiftDate','outgoingContextId','incomingContextId'], [PATIENT,STAFF],
    [section('staff','Staff Workload','person / actual context'),section('allocations','Published Patient Allocations','encounter / comparison side'),section('continuity','Continuity','encounter across compared shifts')],
    ['shift','staff'],['staff','workload'], 'SHIFT_COMPARISON'),
  definition('handover_review_follow_up','Handover review follow-up','Follow first detection, review and publication without implying receipt.',
    [...org,'fromDate','toDate','shiftDate','shiftTypeId','reviewStatus','reviewerId'], ['fromDate','toDate'], [PATIENT,STAFF,REVIEW],
    [section('reviews','Logical Reviews','canonical group; first handover detection in range'),section('members','Original Review Records','original workflow / group'),section('lifecycle','Lifecycle Events','recorded source evidence / workflow'),section('gaps','Evidence Gaps','excluded original workflow')], ['reviewStatus','unit'],['firstDetected','reviewedTime'], 'FIRST_DETECTION'),
];
// Only implemented readers are enabled. Per-report overrides leave other forms unchanged.
Object.assign(reports[0], { available:true, unavailableReason:'', fieldOverrides:{
  shiftDate:{label:'Shift date',semantics:'End of the selected date; today shows data so far. Choose today or an earlier date.'},
} });
Object.assign(reports[1], {available:true,unavailableReason:'',fieldOverrides:{
  shiftDate:{label:'Shift date',semantics:'End of the selected date; today shows data so far. Choose today or an earlier date.'},
} });
Object.assign(reports[2], {available:true,unavailableReason:'',fieldOverrides:{
  shiftDate:{label:'Shift date',semantics:'Changes during the selected date; today shows changes so far. Choose today or an earlier date.'},
} });
Object.assign(reports[3], {available:true,unavailableReason:'',fieldOverrides:{
  shiftDate:{label:'Target shift date',semantics:'Business start date. Today also offers a running overnight context or next-day context; selecting it applies its actual date. Completed-shift readiness is unavailable.'},
  shiftTypeId:{semantics:'Optional target-type restriction; explicit roster times remain authoritative.'},
} });
Object.assign(reports[4], {available:true,unavailableReason:'',defaults:{...reports[4].defaults,issueTimeMode:'NOW',issueLifecycle:'ACTIVE'},fieldOverrides:{
 referenceTime:{dependsOn:['issueTimeMode'],visibleWhen:{issueTimeMode:'REFERENCE'},semantics:'Exact reference with offset. Earlier detections remain included; historical source history may be incomplete.'},
 shiftDate:{default:null,dependsOn:['issueTimeMode'],visibleWhen:{issueTimeMode:'HANDOVER'}},
 shiftTypeId:{dependsOn:['divisionId','departmentId','unitId','issueTimeMode'],visibleWhen:{issueTimeMode:'HANDOVER'}},
 shiftContextId:{dependsOn:['unitId','shiftDate','shiftTypeId','issueTimeMode'],visibleWhen:{issueTimeMode:'HANDOVER'},label:'Incoming approved boundary'},
 issueReason:{lookup:'outstandingReasons',dependsOn:['divisionId','departmentId','unitId','issueTimeMode','referenceTime','shiftDate','shiftContextId','issueDomain','issueCategory']},
} });
Object.assign(reports[5], {available:true,unavailableReason:'',fieldOverrides:{
 shiftDate:{label:'Incoming shift date'},shiftTypeId:{label:'Incoming shift type (optional)'},
 incomingContextId:{label:'Incoming approved context',dependsOn:['unitId','shiftDate','shiftTypeId'],semantics:'Workload observation at actual start. Explicit interval; future means current recorded plan.'},
 outgoingContextId:{label:'Outgoing approved context',semantics:'Observation immediately before its end or incoming start (earlier); not a pooled shift total.'},
 assignedStaffId:{label:'Staff (display filter)',lookup:'workload',dependsOn:['unitId','shiftDate','outgoingContextId','incomingContextId','staffTypeId'],semantics:'Selected staff rows and applicable responsibility on either side. Latest publication selected first; full-unit benchmark stays independent.'},
 staffTypeId:{lookup:'workload',dependsOn:['unitId','shiftDate','outgoingContextId','incomingContextId'],semantics:'Recorded type in either selected context, never a patient subset. Full departmental load remains visible per staff row.'},
} });
Object.assign(reports[6], {available:true,unavailableReason:'',fieldOverrides:{
 fromDate:{label:'First handover detection - from',semantics:'Inclusive business date of the logical group first evidenced HANDOVER detection, not target shift date.'},
 toDate:{label:'First handover detection - through',semantics:'Inclusive cohort end. Later review/publication activity is included through generation time.'},
 shiftDate:{default:null,label:'Target shift date (optional)',semantics:'Recorded workflow shift start date, independent of detection-date cohort. No current roster context is invented.'},
 shiftTypeId:{label:'Target shift type (optional)',semantics:'Recorded workflow shift type. Captured actual staff intervals stay in detail; default type times are never substituted.'},
 reviewStatus:{label:'Current canonical workflow status',semantics:'Current root status at generation. A skip is a separate recorded decision and may leave the workflow REVIEWED or OPEN.'},
 reviewerId:{lookup:'reviewFollowUp',label:'Recorded review actor (optional)',dependsOn:['divisionId','departmentId','unitId','fromDate','toDate','shiftDate','shiftTypeId','reviewStatus'],semantics:'Recorded OPENED/review actor after first handover detection; not assigned staff or notified recipient.'},
} });
function fail(message, status = 400, code = 'REPORT_VALIDATION') {
  return Object.assign(new Error(message), { status, code });
}
function report(id) {
  const found = reports.find(r => r.id === id);
  if (!found) throw fail('Choose a registered Clinical Handover report.');
  return found;
}
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
function parameters(def, input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Parameters must be an object.');
  const allowed = [...def.parameters, 'groupBy','sortBy'];
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key)) throw fail(`Parameter ${key} is not supported by ${def.title}.`);
    if (value == null || value === '') continue;
    if (key === 'groupBy' || key === 'sortBy') {
      if (!(key === 'groupBy' ? def.groupingOptions : def.sortingOptions).includes(value)) throw fail(`Choose a supported ${key}.`);
    } else {
      const f = fields[key];
      if (f.type === 'date' && !date(value)) throw fail(`${f.label}: enter a valid date.`);
      if (f.type === 'instant' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !date(value.slice(0,10)) || !Number.isFinite(Date.parse(value)))) throw fail(`${f.label}: include a valid time and UTC offset.`);
      if (f.type === 'enum' && !f.options.includes(value)) throw fail(`${f.label}: choose a listed value.`);
      if (f.type === 'lookup') {
        if (f.multiple) {
          if (!Array.isArray(value) || !value.length || value.length>100 || value.some(v=>!Number.isSafeInteger(v)||v<=0||v>2147483647) || new Set(value).size!==value.length) throw fail(`${f.label}: choose 1 to 100 distinct encounters, or clear for all.`);
        } else if (key==='targetContextKey') {
          if (typeof value!=='string' || !/^(ROSTER|CAPACITY):[1-9][0-9]{0,9}$/.test(value) || Number(value.split(':')[1])>2147483647) throw fail('Choose a named current/upcoming target context.');
        } else if (['room','bed','issueReason','clinicalStatus'].includes(key)) {
          if (typeof value !== 'string' || value.length > 120) throw fail(`${f.label}: invalid selection.`);
        } else if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw fail(`${f.label}: choose a named record.`);
      }
    }
    out[key] = fields[key]?.type === 'instant' ? new Date(value).toISOString() : value;
  }
  if (out.fromDate && out.toDate) {
    const days = (Date.parse(out.toDate)-Date.parse(out.fromDate))/86400000;
    if (days < 0 || days > 30) throw fail('Choose an inclusive range of 1 to 31 business dates.');
  }
  if (out.departmentId && !out.divisionId) throw fail('Choose the division for this department.');
  if ((out.room || out.bed) && !out.unitId) throw fail('Choose a unit before a room or bed.');
  if (out.bed && !out.room) throw fail('Choose a room before a bed.');
  for (const key of ['shiftContextId','outgoingContextId','incomingContextId','targetContextKey']) {
    if (out[key] && (!out.unitId || !out.shiftDate)) throw fail('Choose a unit and dated shift before its context.');
  }
  if (out.outgoingContextId && out.outgoingContextId === out.incomingContextId) throw fail('Choose two different shift contexts.');
  if (def.id==='workload_and_continuity' && (out.assignedStaffId||out.staffTypeId) && (!out.outgoingContextId||!out.incomingContextId)) throw fail('Choose both actual shift contexts before staff filters.');
  if (def.id==='outstanding_handover_issues') {
    const mode=out.issueTimeMode||def.defaults.issueTimeMode;
    if (mode!=='REFERENCE' && out.referenceTime) throw fail('Use Reference mode for an explicit time.');
    if (mode!=='HANDOVER' && ['shiftDate','shiftTypeId','shiftContextId'].some(k=>out[k]!=null)) throw fail('Use Handover mode for shift-context filters.');
    if (!partial && mode==='REFERENCE' && !out.referenceTime) throw fail('Enter the reference time with its UTC offset.');
    if (!partial && mode==='HANDOVER' && (!out.unitId||!out.shiftDate||!out.shiftContextId)) throw fail('Choose the unit, shift date and explicit incoming boundary.');
  }
  if (!partial) for (const key of def.required) if (out[key] == null) throw fail(`${fields[key].label} is required.`);
  return { ...def.defaults, ...out };
}
module.exports = { OPEN, EXPORT, PATIENT, STAFF, REVIEW, fields, reports, report, parameters, fail };
