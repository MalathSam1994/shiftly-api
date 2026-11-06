const { buildShiftPeriodOverviewSql } = require('./shiftPeriodOverview');
const { scopedPeriodsWhere } = require('../utils/shiftPeriodScope');

// One read-only database snapshot. Reuse the period overview's authoritative
// rule precedence, occupied-place definition and historical patient census.
// Only the already-authorized outer period may bypass its inner scope guard.
const periodOverview = buildShiftPeriodOverviewSql({
  periodReference: 'selected_period.id',
  actorIndex: 1,
  timezoneReference: '$10',
  periodScopeSql: 'true',
  includeCoverageGroups: true,
  fromReference: '$2',
  toReference: '$3',
  coverageOnly: true,
}).trim().replace(/;$/, '');

const desktopShiftMatrixCoverageSql = `
WITH actor AS MATERIALIZED (
  SELECT u.id,
    shiftly_api.fn_user_has_permission(u.id, 'action:shift_search:include_all_shifts') AS include_all,
    shiftly_api.fn_user_has_permission(u.id, 'screen:shift_periods:open') AS open_periods,
    shiftly_api.fn_user_has_permission(u.id, 'action:shift_periods:edit_approved_assignments') AS edit_approved
  FROM shiftly_schema.users u WHERE u.id = $1 AND u.is_active
), access AS (
  SELECT a.*, a.include_all OR EXISTS (
    SELECT 1 FROM shiftly_schema.user_managers um
    WHERE um.manager_user_id = a.id AND um.is_active
      AND um.division_id IS NOT NULL AND um.department_id IS NOT NULL
  ) AS scope_available FROM actor a
), authorized_periods AS MATERIALIZED (
  SELECT sp.*, dv.division_desc, dep.department_desc,
    a.open_periods AND ${scopedPeriodsWhere('sp', 1).sql}
      AND (upper(COALESCE(sp.status, '')) <> 'APPROVED' OR a.edit_approved) AS can_manage
  FROM shiftly_schema.shift_periods sp CROSS JOIN access a
  LEFT JOIN shiftly_schema.divisions dv ON dv.id = sp.division_id
  LEFT JOIN shiftly_schema.departments dep ON dep.id = sp.department_id
  WHERE sp.end_date >= $2::date AND sp.start_date < $3::date
    AND upper(COALESCE(sp.status, '')) <> 'CANCELLED'
    AND ($4::integer IS NULL OR sp.division_id = $4)
    AND ($5::integer IS NULL OR sp.department_id = $5)
    AND (a.include_all OR EXISTS (
      SELECT 1 FROM shiftly_schema.user_managers um
      WHERE um.manager_user_id = a.id AND um.division_id = sp.division_id
        AND um.department_id = sp.department_id AND um.is_active
    ))
), scoped_matches AS MATERIALIZED (
  -- Legacy search deployments may timezone-convert the returned date-only
  -- label. Authorize IDs through that function, then match the stored business
  -- date; a one-day padding prevents that legacy label from losing boundaries.
  SELECT scoped.shift_assignment_id, actual.shift_period_id, actual.shift_date,
    actual.division_id, actual.department_id, actual.staff_type_id, actual.shift_type_id
  FROM shiftly_api.fn_desktop_shift_matrix_search(
    $1::integer, $2::date - 1, $3::date + 1, $4::integer, $5::integer,
    $6::integer, $7::integer, $8::integer, $9::character varying
  ) scoped JOIN shiftly_schema.shift_assignments actual ON actual.id = scoped.shift_assignment_id
  WHERE actual.shift_date >= $2::date AND actual.shift_date < $3::date
), matched_groups AS MATERIALIZED (
  -- Aggregate once instead of rescanning every authorized assignment for each
  -- displayed group (and again for its assignee/status filter).
  SELECT shift_period_id, shift_date, division_id, department_id, staff_type_id, shift_type_id,
    jsonb_agg(shift_assignment_id ORDER BY shift_assignment_id) AS assignment_ids
  FROM scoped_matches
  GROUP BY shift_period_id, shift_date, division_id, department_id, staff_type_id, shift_type_id
), period_snapshots AS MATERIALIZED (
  SELECT selected_period.*, snapshot.overview
  FROM authorized_periods selected_period
  CROSS JOIN LATERAL (${periodOverview}) snapshot
), days AS MATERIALIZED (
  SELECT p.id AS shift_period_id, p.status AS period_status, p.division_id, p.department_id,
    p.division_desc, p.department_desc, p.can_manage, d.*
  FROM period_snapshots p CROSS JOIN LATERAL jsonb_to_recordset(p.overview->'days') AS d(
    date text, coverage_groups jsonb, ambiguous_shifts jsonb,
    patient_count integer, patient_baseline numeric, patient_delta numeric,
    patient_alert boolean, patient_comparisons jsonb
  ) WHERE d.date::date >= $2::date AND d.date::date < $3::date
), groups AS MATERIALIZED (
  SELECT d.*, g.* FROM days d CROSS JOIN LATERAL jsonb_to_recordset(d.coverage_groups) AS g(
    staff_type_id integer, shift_type_id integer, capacity_group_id integer,
    label text, category text, is_night boolean, start_time text, end_time text,
    assigned integer, required integer, approved integer, pending_requests integer,
    inferred boolean, missing boolean
  )
  UNION ALL
  SELECT d.*, NULL::integer, NULL::integer, NULL::integer, g.label, g.category, g.is_night,
    NULL::text, NULL::text, 0, NULL::integer, 0, 0, true, g.missing
  FROM days d CROSS JOIN LATERAL jsonb_to_recordset(d.ambiguous_shifts) AS g(
    label text, category text, is_night boolean, missing boolean
  )
), visible_groups AS MATERIALIZED (
  SELECT g.*, COALESCE(m.assignment_ids, '[]'::jsonb) AS assignment_ids
  FROM groups g LEFT JOIN matched_groups m
    ON m.shift_period_id = g.shift_period_id AND m.shift_date = g.date::date
    AND m.division_id = g.division_id AND m.department_id = g.department_id
    AND m.staff_type_id IS NOT DISTINCT FROM g.staff_type_id
    AND m.shift_type_id IS NOT DISTINCT FROM g.shift_type_id
  WHERE ($6::integer IS NULL OR g.staff_type_id = $6)
    AND ($7::integer IS NULL OR g.shift_type_id = $7)
    -- Assignee/status filters select entire groups. They must never lower the
    -- numerator of actual group coverage or invent a staffing gap.
    AND (($8::integer IS NULL AND $9::text IS NULL) OR m.assignment_ids IS NOT NULL)
), coverage AS MATERIALIZED (
  SELECT concat_ws(':', g.shift_period_id, g.date, COALESCE(g.staff_type_id::text, 'unknown'),
      COALESCE(g.shift_type_id::text, g.category)) AS group_key,
    g.shift_period_id, g.period_status, g.date AS shift_date,
    g.division_id, g.division_desc, g.department_id, g.department_desc,
    g.staff_type_id, staff.staff_type_name, g.shift_type_id, g.label AS shift_label,
    st.shift_code, g.start_time, g.end_time, g.category, g.is_night,
    g.capacity_group_id, g.required AS required_staff, g.assigned AS assigned_staff,
    g.approved AS approved_staff, g.pending_requests,
    CASE WHEN g.required IS NOT NULL THEN greatest(0, g.required - g.assigned) END AS gap,
    CASE WHEN g.required IS NOT NULL THEN greatest(0, g.assigned - g.required) END AS excess,
    CASE WHEN g.required > 0 THEN round(100.0 * least(g.assigned, g.required) / g.required, 1)
      WHEN g.required = 0 THEN 100::numeric END AS coverage_percent,
    CASE WHEN g.required IS NULL THEN 'UNKNOWN'
      WHEN g.assigned > g.required THEN 'OVERSTAFFED'
      WHEN g.assigned >= g.required THEN 'FULL'
      WHEN g.assigned = 0 THEN 'UNCOVERED' ELSE 'PARTIAL' END AS coverage_status,
    g.missing, g.inferred, g.assignment_ids, g.can_manage,
    g.patient_count, g.patient_baseline, g.patient_delta,
    CASE WHEN g.patient_baseline > 0 THEN round(100.0 * g.patient_delta / g.patient_baseline, 1) END AS patient_change_percent,
    COALESCE(g.patient_alert, false) AS patient_alert,
    g.patient_count IS NOT NULL AND g.patient_baseline IS NOT NULL AS patient_context_available,
    'Compared with the previous 7 observed days (at least 3 known days); an alert requires both 3 patients and 20% change.'::text AS patient_change_reason,
    (SELECT c->>'observed_at' FROM jsonb_array_elements(g.patient_comparisons) c
      WHERE c->>'key' = 'selected_day' LIMIT 1) AS patient_observed_at
  FROM visible_groups g LEFT JOIN shiftly_schema.staff_types staff ON staff.id = g.staff_type_id
  LEFT JOIN shiftly_schema.shift_types st ON st.id = g.shift_type_id
)
SELECT jsonb_build_object(
  'rows', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.shift_date, c.department_desc,
    c.division_id, c.start_time, c.staff_type_id) FROM coverage c), '[]'::jsonb),
  'data_scope', CASE WHEN a.include_all THEN 'ALL_SHIFTS' ELSE 'MANAGED_DEPARTMENTS' END,
  'can_include_all_shifts', a.include_all, 'scope_available', a.scope_available,
  'has_periods', EXISTS (SELECT 1 FROM authorized_periods),
  'capabilities', jsonb_build_object('can_open_periods', a.open_periods,
    'can_create_period', a.open_periods, 'can_edit_assignments', a.open_periods,
    'can_edit_approved_assignments', a.edit_approved),
  'patient_baseline_description',
    'Observed department census versus the previous 7 days, requiring 3 known days and a change of at least 3 patients and 20%. Future or incomplete observations and unauthorized patient context remain unknown.',
  'summary', (SELECT jsonb_build_object(
    'total_groups', count(*),
    'fully_covered', count(*) FILTER (WHERE coverage_status IN ('FULL','OVERSTAFFED')),
    'partial', count(*) FILTER (WHERE coverage_status = 'PARTIAL'),
    'uncovered', count(*) FILTER (WHERE coverage_status = 'UNCOVERED'),
    'overstaffed', count(*) FILTER (WHERE coverage_status = 'OVERSTAFFED'),
    'unknown', count(*) FILTER (WHERE coverage_status = 'UNKNOWN'),
    'missing_shifts', count(*) FILTER (WHERE missing),
    'missing_staff', COALESCE(sum(gap), 0),
    'coverage_percent', CASE WHEN sum(required_staff) > 0
      THEN round(100.0 * sum(least(assigned_staff, required_staff)) FILTER (WHERE required_staff IS NOT NULL)
        / sum(required_staff), 1) END,
    'patient_changes', count(DISTINCT (division_id, department_id, shift_date)) FILTER (WHERE patient_alert),
    'at_risk', count(DISTINCT (division_id, department_id, shift_date)) FILTER (WHERE patient_alert)
  ) FROM coverage)
) AS payload FROM access a;
`;

module.exports = { desktopShiftMatrixCoverageSql };
