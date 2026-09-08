// Presentation of persisted review evidence. Eligibility remains authoritative in
// PostgreSQL; this service never grants eligibility or guesses an action's origin.
const triggerTitles = {
  HANDOVER: 'Handover assignment review', ACTIVE_REEVALUATION: 'Assignment reevaluation',
  NEW_PATIENT: 'Patient entry or encounter update', TRANSFER_IN: 'Patient transfer into unit',
  TRANSFER_OUT: 'Patient transfer out of unit', DISCHARGE: 'Patient discharge',
  ACUITY_CHANGE: 'Patient acuity changed', WORKLOAD_CHANGE: 'Patient workload changed',
  COMPETENCY_CHANGE: 'Clinical competency changed', SUDDEN_ABSENCE: 'Staff availability changed',
  SHIFT_SWITCH: 'Scheduled nurse changed', SHIFT_OFFER_APPROVED: 'Shift offer approved',
  STAFFING_CHANGE: 'Clinical staffing changed', PUBLISH: 'Assignment publication',
};
const list = value => Array.isArray(value) ? value : [];
const text = value => value == null ? 'Unavailable'
  : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(String(value))
    ? String(value).slice(0,19).replace('T',' ') : String(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readable = value => text(value).replace(/_/g, ' ').toLowerCase();
function describeClinicalAttention(data) {
  const names = data.names || {};
  const name = (type, id) => list(names[type]).find(row => String(row.id) === String(id))?.name || 'Description unavailable';
  const patient = id => {
    const p = list(names.patients).find(row => String(row.id) === String(id));
    return p ? [p.name, p.reference, p.encounter && 'Encounter ' + p.encounter].filter(Boolean).join(' · ') : 'Patient description unavailable';
  };
  const paragraphs = [];
  const changes = [];
  const affected = [];
  const records = [];
  const requirements = [];
  const snapshot = data.snapshot || {};
  const baseline = data.baseline;
  const scoped = rows => list(rows).filter(p => data.unit_id == null || String(p.current_clinical_unit_id) === String(data.unit_id));
  const before = scoped(baseline?.patients);
  const after = scoped(snapshot.patients);
  const staff = list(data.staff);
  const detection = data.detection || {};
  const reasons = [...new Set([...list(data.reasons), ...list(detection.reason_codes)])];
  const display = (type, value) => value == null ? 'Unavailable' : name(type, value);
  const field = (label, oldValue, newValue) => ({ label, previous: text(oldValue), current: text(newValue) });

  // Only compare a saved baseline to a saved detection state, never to today's
  // state while presenting it as a historical event.
  if (data.historical && baseline) {
    const encounterIds = new Set([...before, ...after].map(p => p.encounter_id));
    for (const id of encounterIds) {
      const old = before.find(p => p.encounter_id === id);
      const now = after.find(p => p.encounter_id === id);
      const fields = [];
      const chain = [];
      if (!old || !now) {
        chain.push(old ? 'This encounter left the unit population used by the assignment.' : 'This encounter entered the unit population used by the assignment.');
      } else {
        for (const [key, label, type] of [
          ['score','Score'], ['workload','Workload'], ['adt_burden','ADT burden'],
          ['acuity_level_id','Acuity level','levels'], ['current_clinical_unit_id','Clinical unit','units'],
          ['encounter_status','Encounter status'], ['room_label','Room'], ['bed_label','Bed'],
        ]) {
          if (!equal(old[key], now[key])) fields.push(field(label, type ? display(type,old[key]) : old[key], type ? display(type,now[key]) : now[key]));
        }
        const factorIds = new Set([...list(old.factors), ...list(now.factors)].map(f => f[0]));
        for (const factorId of factorIds) {
          const oldValues = list(old.factors).filter(f => f[0] === factorId).map(f => f[1]);
          const newValues = list(now.factors).filter(f => f[0] === factorId).map(f => f[1]);
          if (!equal(oldValues,newValues)) {
            fields.push(field(name('factors',factorId) + ' — recorded factor values', oldValues.length ? oldValues.join(', ') : 'Not recorded', newValues.length ? newValues.join(', ') : 'No active value'));
            chain.push(name('factors',factorId) + (oldValues.length ? ' factor values changed.' : ' factor was added.'));
          }
        }
        const added = list(now.required_competencies).filter(id => !list(old.required_competencies).includes(id));
        const removed = list(old.required_competencies).filter(id => !list(now.required_competencies).includes(id));
        if (added.length) chain.push('The patient now requires: ' + added.map(id => name('competencies',id)).join(', ') + '.');
        if (removed.length) chain.push('No longer required for this patient: ' + removed.map(id => name('competencies',id)).join(', ') + '.');
        const assigned = rows => list(rows).map(a => name('users',a[0])).join(', ') || 'Unassigned';
        if (!equal(old.published_assignments,now.published_assignments)) fields.push(field('Published nurse assignment',assigned(old.published_assignments),assigned(now.published_assignments)));
        if (!equal(old.flow_events,now.flow_events)) chain.push('The active ADT/flow events changed. See linked patient actions for the event and recorded action time.');
      }
      if (fields.length || chain.length) changes.push({ title: patient(id), fields, paragraphs: chain });
    }
    // Staff identity, effective competency and availability comparisons use
    // like-for-like unit scope only; department baseline eligibility is not unit eligibility.
    if (data.baseline_unit_id === data.unit_id) {
      const oldStaff = list(baseline.staff);
      for (const now of list(snapshot.staff)) {
        const old = oldStaff.find(s => s.shift_assignment_id === now.shift_assignment_id);
        const fields = [];
        if (!old) fields.push(field('Scheduled candidate','Not in baseline','In candidate pool'));
        else {
          for (const [key,label] of [['is_eligible','Eligible'],['assignment_status','Shift status'],['has_user_absence','Absence'],['max_workload','Workload capacity'],['max_patient_count','Patient capacity'],['max_high_acuity_count','High/Extreme capacity'],['start_time','Shift start'],['end_time','Shift end']]) {
            if (!equal(old[key],now[key])) fields.push(field(label,old[key],now[key]));
          }
          if (!equal(old.competencies,now.competencies)) fields.push(field('Effective competencies',
            list(old.competencies).map(id => name('competencies',id)).join(', ') || 'None',
            list(now.competencies).map(id => name('competencies',id)).join(', ') || 'None'));
        }
        if (fields.length) changes.push({ title: name('users',now.user_id), fields, paragraphs: [] });
      }
      for (const old of oldStaff.filter(s => !list(snapshot.staff).some(n => n.shift_assignment_id === s.shift_assignment_id))) {
        changes.push({title:name('users',old.user_id),fields:[field('Scheduled candidate','In baseline','No longer in candidate pool')],paragraphs:[]});
      }
    }
  }

  for (const p of list(data.patient_requirements)) {
    const currentPatient = after.find(row => row.encounter_id === p.encounter_id);
    const lines = [];
    for (const link of list(p.factor_links)) {
      lines.push(link.factor_name + ' factor → ' + link.competency_name + ' competency required by “' + link.requirement_name + '”.');
    }
    for (const requirement of list(p.requirements)) {
      for (const source of list(requirement.requirement_sources).filter(s => s.source !== 'ACUITY_FACTOR')) {
        lines.push(readable(source.source) + ' rule “' + source.name + '” → ' + requirement.competency_name + ' competency required.');
      }
      for (const assignment of list(currentPatient?.published_assignments)) {
        const nurse = staff.find(s => s.user_id === assignment[0] && s.shift_assignment_id === assignment[1]);
        if (nurse && !list(nurse.competencies).some(c => c.competency_id === requirement.competency_id)) {
          lines.push('Assigned nurse ' + (nurse.user_desc || nurse.user_name || name('users',nurse.user_id)) +
            ' lacks effective ' + requirement.competency_name + ' competency for this shift → the assignment is ineligible → manager review/rebalance is required.');
        }
      }
    }
    if (lines.length) requirements.push({title:patient(p.encounter_id),paragraphs:lines,fields:[]});
  }
  if (requirements.length) paragraphs.push('Requirement rules shown below were saved at detection. Staff-pool eligibility also combines requirements across the selected unit: a factor on one patient can make a nurse ineligible for the unit, even if that nurse is assigned to another patient.');

  for (const nurse of staff) {
    const patients = after.filter(p => list(p.published_assignments).some(a => a[0] === nurse.user_id && a[1] === nurse.shift_assignment_id));
    if (nurse.is_eligible === false) {
      const missing = list(nurse.missing_competencies).map(c => c.competency_name).filter(Boolean);
      const why = list(nurse.ineligibility_reasons).map(text);
      if (missing.length) why.unshift('Missing required competencies: ' + missing.join(', ') + '.');
      affected.push({
        title: nurse.user_desc || nurse.user_name || name('users',nurse.user_id),
        paragraphs: [
          patients.length ? 'Published nurse for: ' + patients.map(p => patient(p.encounter_id)).join('; ') + '.' : 'Scheduled candidate; not assigned to a patient in this review population.',
          ...why,
          patients.length ? 'This published assignment needs manager review because the nurse does not satisfy eligibility in the displayed evidence.' : 'This nurse was not eligible for selection in the displayed evidence.',
        ], fields: [],
      });
    }
  }
  for (const p of after) {
    for (const assignment of list(p.published_assignments)) {
      if (!staff.some(s => s.user_id === assignment[0] && s.shift_assignment_id === assignment[1])) {
        affected.push({title:name('users',assignment[0]),fields:[],paragraphs:[
          'Published nurse for ' + patient(p.encounter_id) + ' is absent from the scheduled candidate pool for this shift.',
          'The assignment cannot be validated against that pool and needs review. See the recorded staffing action, if available, for the specific schedule/availability change; absence from the pool alone does not prove an absence request.',
        ]});
      }
    }
  }
  const unassigned = after.filter(p => !list(p.published_assignments).length);
  if (unassigned.length) affected.push({title:'Unassigned patients',paragraphs:unassigned.map(p => patient(p.encounter_id)),fields:[]});
  if (staff.length && staff.every(s => s.is_eligible !== true)) paragraphs.push('None of the ' + staff.length + ' scheduled candidates satisfies the unit/shift eligibility rules in the displayed evidence.');
  if (!staff.length) paragraphs.push('No scheduled candidates are available in the displayed evidence.');

  if (reasons.includes('BALANCE_GAP')) {
    paragraphs.push('Recorded workload gap: ' + text(detection.balance_gap) + '; review threshold: ' + text(detection.imbalance_threshold) + '. This is the absolute workload difference between assigned nurses, not the optimizer utilization gap.');
    const loads = new Map();
    for (const p of after) for (const a of list(p.published_assignments)) {
      const entries = loads.get(a[0]) || [];
      entries.push(p); loads.set(a[0],entries);
    }
    for (const [userId, patients] of loads) affected.push({title:name('users',userId) + ' — workload contributing to gap',fields:[],
      paragraphs:patients.map(p => patient(p.encounter_id) + ': workload ' + text(p.workload))});
  }
  if (reasons.includes('ASSIGNMENT_REVIEW_REQUIRED')) paragraphs.push('Published assignments were flagged for review. A flag alone does not establish which clinical action caused it.');
  if (data.trigger === 'HANDOVER') paragraphs.push('The incoming shift assignment was checked for handover readiness; the findings below explain the review. This does not mean a patient was transferred.');
  if (reasons.includes('PUBLISHED_INPUTS_CHANGED')) paragraphs.push('The recorded patient, staffing or policy inputs differ from the last accepted publication.');
  if (data.historical && baseline && !equal(baseline.policy,snapshot.policy)) paragraphs.push('The applicable optimizer policy changed since publication.');
  if (data.historical && baseline && !equal(baseline.review_threshold,snapshot.review_threshold)) paragraphs.push('Review threshold changed from ' + text(baseline.review_threshold) + ' to ' + text(snapshot.review_threshold) + '.');

  for (const op of list(data.operations).slice(0,200)) {
    const beforeState = op.before_state || {}, afterState = op.after_state || {};
    // ADT stores encounter/location/event separately; factor operations store
    // the factor-value row directly. Do not mistake the event catalogue for a
    // patient event value or lose a transfer/discharge in nested JSON.
    const old = beforeState.encounter || beforeState, now = afterState.encounter || afterState;
    const fields = [];
    const factorId = now.factor_id ?? old.factor_id;
    if (factorId != null) fields.push(field(name('factors',factorId) + ' — recorded factor value',old.factor_value ?? 'Not recorded in before-state',now.factor_value ?? 'No after-value recorded'));
    const eventType = now.event_type_id ?? old.event_type_id;
    if (eventType != null) fields.push(field('ADT/flow event',old.event_type_id == null ? 'Not recorded' : name('event_types',old.event_type_id), name('event_types',eventType)));
    if (afterState.event?.event_name) fields.push(field('Recorded ADT/flow event', 'Not an event before-state', afterState.event.event_name));
    for (const [key,label,type] of [['encounter_status','Encounter status'],['current_clinical_unit_id','Clinical unit','units'],['target_clinical_unit_id','Destination unit','units'],['clinical_status','Clinical status'],['event_value','Event value'],['ended_at','Ended at'],['admitted_at','Admission'],['discharged_at','Discharge']]) {
      if (!equal(old[key],now[key])) fields.push(field(label,type ? display(type,old[key]) : old[key],type ? display(type,now[key]) : now[key]));
    }
    if (op.score != null) fields.push(field('Score',op.previous_score,op.score));
    if (op.workload != null) fields.push(field('Workload',op.previous_workload,op.workload));
    if (op.adt_burden != null) fields.push(field('ADT burden',op.previous_adt,op.adt_burden));
    records.push({title:patient(op.encounter_id) + ' — ' + readable(op.operation_type),
      paragraphs:[op.directly_linked ? 'This recorded action is directly linked to this review.' : 'Recorded during the accepted-baseline-to-review interval; it is supporting evidence, not proof that it alone caused this review.',
        ...(op.score == null ? [] : ['Score/workload/ADT are compared with the preceding assessment ordered by assessment date/time. For backdated assessments this is not necessarily the last action performed; the publication comparison is shown separately above.'])],
      fields, action:op.action});
  }
  for (const assessment of list(data.assessments)) records.push({
    title:patient(assessment.encounter_id) + ' — linked acuity assessment',
    paragraphs:['The review references this assessment directly. No patient-operation audit is linked to it; the assessment’s own action metadata is shown. Previous values come from the preceding assessment ordered by assessment date/time, not an inferred action order.',
      'Acuity level: ' + text(assessment.acuity_level)],
    fields:[field('Score',assessment.previous_score,assessment.score),
      field('Workload',assessment.previous_workload,assessment.workload),
      field('ADT burden',assessment.previous_adt,assessment.adt_burden)],action:assessment.action,
  });
  for (const assignment of list(data.assignment_history).slice(0,200)) records.push({
    title:patient(assignment.encounter_id) + ' — ' + readable(assignment.change_type),
    paragraphs:['Recorded in this shift scope between publication and detection. Assignment generation/publication history is context, not by itself evidence of a new clinical change.',
      assignment.change_reason || 'No change reason was recorded.'],
    fields:[field('Nurse',assignment.previous_assigned_user_id == null ? 'Unassigned' : name('users',assignment.previous_assigned_user_id),
      assignment.new_assigned_user_id == null ? 'Unassigned' : name('users',assignment.new_assigned_user_id))],action:assignment.action,
  });
  if (data.staff_change) {
    const change = data.staff_change, old = change.before || {}, now = change.after || {};
    const fields = [];
    for (const [key,label,type] of [['competency_id','Competency','competencies'],['user_id','Nurse','users'],['staff_type_id','Staff type','staff_types'],['is_active','Active'],['valid_from','Valid from'],['valid_to','Valid until'],['status','Shift status'],['is_absence','Absence setting'],['absence_type','Absence type'],['start_date','Absence from'],['end_date','Absence through'],['shift_date','Shift date'],['shift_type_id','Shift','shifts'],['division_id','Division','divisions'],['department_id','Department','departments'],['start_time','Shift start'],['end_time','Shift end']]) {
      const value = v => key === 'is_absence' ? (v === 1 ? 'Marked absent' : v === 2 ? 'Not marked absent' : text(v)) : type ? display(type,v) : v;
      if (!equal(old[key],now[key])) fields.push(field(label,value(old[key]),value(now[key])));
    }
    const who = now.user_id ?? old.user_id ?? data.source_detail?.user_id;
    const competency = now.competency_id ?? old.competency_id;
    records.unshift({title:name('users',who) + (competency == null ? '' : ' — ' + name('competencies',competency)),
      paragraphs:['Recorded staffing change: ' + readable(change.operation)],fields,action:change.action});
  }
  const limitations = [];
  if (!data.historical) limitations.push('This older review did not store its detection snapshot. Eligibility below is CURRENT, not evidence of who was ineligible when the review was created.');
  if (!baseline) limitations.push('An accepted before-snapshot is unavailable; prior values are shown only where a linked audit record actually stored them.');
  if (!records.length) limitations.push('No linked action with actor/source/time could be reconstructed. The review detection time is not being used as a nurse action time.');
  if (list(data.operations).length > 200) limitations.push('Showing the latest 200 supporting patient actions. Use Patient History for older entries.');
  if (list(data.assignment_history).length > 200) limitations.push('Showing the latest 200 supporting assignment actions.');
  if (!data.historical || data.patient_requirements == null) limitations.push('Historical factor-to-competency rule links were not captured for this review. Current rules are not substituted as historical fact.');
  if (!changes.length && !records.length && !affected.length && !reasons.includes('BALANCE_GAP')) limitations.push('No meaningful causal change was reconstructed. This may be a legacy/stale review; it is not proof that a clinical action occurred.');
  return {
    title: triggerTitles[data.trigger] || 'Clinical assignment review',
    scope: [data.shift_date,data.shift,data.unit || 'Department scope'].filter(Boolean).join(' · '),
    detected_at: data.detected_at,
    evidence_label: data.historical ? 'State recorded when attention was detected' : 'Current state — historical snapshot unavailable',
    paragraphs, limitations,
    sections: [
      {title:'What changed since publication',items:changes},
      {title:'Why factors and acuity affect eligibility',items:requirements},
      {title:data.historical ? 'Who was affected at detection' : 'Current eligibility (not historical)',items:affected},
      {title:'Recorded actions and provenance',items:records},
    ],
  };
}
module.exports = { describeClinicalAttention };
