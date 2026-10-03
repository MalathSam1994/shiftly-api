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
  definition('incoming_shift_readiness','Daily staffing readiness','Staffing and clinical eligibility across all shifts on the selected date.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF,REVIEW],
    [section('staffing','Staffing by shift','period / shift type / role'),section('staff','Scheduled staff','recorded roster assignment')],
    ['unit'],['shift'], 'DAY_PLAN'),
  definition('outstanding_handover_issues','Daily outstanding issues','Recorded outstanding issues at the end of the selected date, or so far today.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF,REVIEW],
    [section('issues','Outstanding issues','recorded primary issue')], ['priority'],['severity'], 'DAY_SNAPSHOT'),
  definition('workload_and_continuity','Daily workload and assignments','Recorded workload and published patient assignments by shift on the selected date.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF],
    [section('staff','Staff workload','person / actual shift'),section('allocations','Patient assignments','encounter / actual shift')],
    ['shift'],['staff'], 'DAY_SHIFTS'),
  definition('handover_review_follow_up','Patient assignment timeline','Patient coverage across scheduled and missing shifts, with published nurses and times.',
    [...org,'shiftDate'], [...org,'shiftDate'], [PATIENT,STAFF,REVIEW],
    [section('coverage','Patient assignment matrix','patient / expected shift')], ['timeline'],['effectiveTime'], 'DAY_PLAN'),
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
  shiftDate:{label:'Shift date',semantics:'All shifts starting on this date. Past dates show retained schedules; today and future dates show the recorded plan.'},
} });
Object.assign(reports[4], {available:true,unavailableReason:'',fieldOverrides:{
 shiftDate:{label:'Shift date',semantics:'Recorded outstanding issues at the end of the selected date; today shows the latest recorded state. Choose today or an earlier date.'},
} });
Object.assign(reports[5], {available:true,unavailableReason:'',fieldOverrides:{
 shiftDate:{label:'Shift date',semantics:'Shifts starting on this date, observed by shift end or day end. Today shows started shifts so far. Choose today or an earlier date.'},
} });
Object.assign(reports[6], {available:true,unavailableReason:'',fieldOverrides:{
 shiftDate:{label:'Shift date',semantics:'Shifts starting on this date, including planned and missing assignments. Future dates show the recorded plan and current patients.'},
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
  if (!partial) for (const key of def.required) if (out[key] == null) throw fail(`${fields[key].label} is required.`);
  return { ...def.defaults, ...out };
}
module.exports = { OPEN, EXPORT, PATIENT, STAFF, REVIEW, fields, reports, report, parameters, fail };
