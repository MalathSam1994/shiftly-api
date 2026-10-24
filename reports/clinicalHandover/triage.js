// Keep triage evidence in the saved generation at the report's clinical cutoff.
// Fixed identifiers only; neither a function name nor a JSON path comes from HTTP.
function dailyTriageQuery(kind) {
  const patient = kind === 'patient';
  const fn = patient ? 'fn_handover_patient_daily_sheet' : 'fn_handover_unit_daily_summary';
  const context = patient ? 'patientContext' : 'unitContext';
  return `WITH source AS MATERIALIZED (
    SELECT shiftly_api.${fn}($1,$2::jsonb) value
  ), evidence AS MATERIALIZED (
    SELECT value, shiftly_api.fn_clinical_triage_snapshots($1,
      ARRAY(SELECT (p->>'encounterId')::integer FROM jsonb_array_elements(value->'patients') p),
      (value#>>'{${context},reference}')::timestamptz) snapshots FROM source
  ) SELECT value || jsonb_build_object('triageSnapshots',snapshots,
    'triageDistribution',shiftly_api.fn_clinical_triage_distribution(snapshots)) value FROM evidence`;
}

function addDailyTriage(data, patientColumns) {
  const snapshots = data.triageSnapshots;
  if (!snapshots || typeof snapshots !== 'object') return patientColumns;
  const applicable = data.patients.some(p => snapshots[String(p.encounterId)]?.applicable === true);
  if (!applicable) return patientColumns;
  for (const patient of data.patients) {
    const triage = snapshots[String(patient.encounterId)];
    patient.triage = triage ?? null;
    patient.triageLevel = triage?.applicable
      ? (triage.level == null ? 'Not recorded' : `ESI ${triage.level}`) : 'Not applicable';
    patient.triageInitial = triage?.initial_level == null ? null : `ESI ${triage.initial_level}`;
    patient.triageAssessedAt = triage?.assessed_at ?? null;
    patient.triageSource = triage?.source ?? null;
    patient.triageAssessedBy = triage?.assessed_by_name ?? null;
  }
  return [...patientColumns,
    {key:'triageLevel',label:'ED triage (ESI)',type:'text'},
    {key:'triageInitial',label:'Initial ESI',type:'text'},
    {key:'triageAssessedAt',label:'Triage assessed',type:'datetime'},
    {key:'triageAssessedBy',label:'Triage recorded by',type:'text'},
    {key:'triageSource',label:'Triage source',type:'text'},
  ];
}
module.exports = {dailyTriageQuery, addDailyTriage};
