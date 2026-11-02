const { scopedPeriodsWhere } = require('../utils/shiftPeriodScope');

// One read-only statement keeps all dates, capacities and census comparisons in
// the same database snapshot. $1 = period, $2 = actor, $3 = business timezone.
const shiftPeriodOverviewSql = `
WITH business_clock AS (
  SELECT now() AT TIME ZONE COALESCE(NULLIF($3::text, ''), current_setting('TimeZone')) AS now
), period AS MATERIALIZED (
  SELECT sp.* FROM shiftly_schema.shift_periods sp
  WHERE sp.id = $1 AND ${scopedPeriodsWhere('sp', 2).sql}
), dates AS (
  SELECT p.start_date + n AS day
  FROM period p CROSS JOIN LATERAL generate_series(-7, p.end_date - p.start_date) n
), period_days AS (
  SELECT d.day FROM dates d CROSS JOIN period p WHERE d.day >= p.start_date
), shift_kinds AS MATERIALIZED (
  SELECT st.id, st.day_type, st.is_active,
    (st.end_time <= st.start_time OR st.start_time >= time '18:00'
      OR st.start_time < time '06:00') AS is_night
  FROM shiftly_schema.shift_types st
), rules AS MATERIALIZED (
  SELECT r.staff_type_id, r.shift_type_id,
    CASE WHEN count(*) = 1 THEN min(r.required_staff_count) END AS required
  FROM shiftly_schema.staff_shift_rules r
  JOIN period p ON p.division_id = r.division_id AND p.department_id = r.department_id
  JOIN shift_kinds st ON st.id = r.shift_type_id AND st.is_active
  JOIN shiftly_schema.staff_types staff ON staff.id = r.staff_type_id AND staff.is_active
  WHERE r.is_active
  GROUP BY r.staff_type_id, r.shift_type_id
), assignments AS MATERIALIZED (
  SELECT a.* FROM shiftly_schema.shift_assignments a
  JOIN period p ON p.id = a.shift_period_id
    AND p.division_id = a.division_id AND p.department_id = a.department_id
  WHERE COALESCE(a.is_absence, 2) <> 1
    AND upper(COALESCE(a.status, '')) <> 'CANCELLED'
), saved_groups AS MATERIALIZED (
  SELECT g.* FROM shiftly_schema.shift_assignment_capacity_groups g
  JOIN period p ON p.id = g.shift_period_id
    AND p.division_id = g.division_id AND p.department_id = g.department_id
), eligible_rule_keys AS (
  SELECT d.day, r.staff_type_id, r.shift_type_id, st.is_night
  FROM period_days d CROSS JOIN rules r
  JOIN shift_kinds st ON st.id = r.shift_type_id
  WHERE st.day_type = 'ANY'
    OR (st.day_type = 'WEEKDAY_ONLY' AND extract(isodow FROM d.day) < 6)
    OR (st.day_type = 'WEEKEND_ONLY' AND extract(isodow FROM d.day) >= 6)
), eligible_rule_kinds AS (
  SELECT day, is_night, count(DISTINCT shift_type_id) AS type_count
  FROM eligible_rule_keys GROUP BY day, is_night
), explicit_keys AS (
  SELECT g.shift_date AS day, g.staff_type_id, g.shift_type_id, st.is_night
  FROM saved_groups g JOIN shift_kinds st ON st.id = g.shift_type_id
  UNION
  SELECT a.shift_date, a.staff_type_id, a.shift_type_id, st.is_night
  FROM assignments a JOIN shift_kinds st ON st.id = a.shift_type_id
), group_keys AS (
  SELECT day, staff_type_id, shift_type_id FROM explicit_keys
  UNION
  -- Rules also contain allowed alternatives. Only infer an absent category
  -- when a single eligible shift type is configured, never add every option.
  SELECT r.day, r.staff_type_id, r.shift_type_id FROM eligible_rule_keys r
  JOIN eligible_rule_kinds k ON k.day = r.day AND k.is_night = r.is_night AND k.type_count = 1
  WHERE NOT EXISTS (SELECT 1 FROM explicit_keys e WHERE e.day = r.day AND e.is_night = r.is_night)
), group_capacity AS (
  SELECT k.day, k.shift_type_id,
    st.is_night,
    COALESCE(g.required_staff_count, r.required) AS required,
    shiftly_api.fn_roster_occupied_places(
      p.id, k.day, p.division_id, p.department_id, k.staff_type_id, k.shift_type_id
    ) AS assigned
  FROM group_keys k CROSS JOIN period p
  JOIN shift_kinds st ON st.id = k.shift_type_id
  LEFT JOIN saved_groups g ON g.shift_date = k.day
    AND g.staff_type_id IS NOT DISTINCT FROM k.staff_type_id AND g.shift_type_id = k.shift_type_id
  LEFT JOIN rules r ON r.staff_type_id IS NOT DISTINCT FROM k.staff_type_id
    AND r.shift_type_id = k.shift_type_id
), shift_capacity AS (
  SELECT day, shift_type_id, is_night, sum(assigned)::integer AS assigned,
    CASE WHEN bool_and(required IS NOT NULL) THEN sum(required)::integer END AS required
  FROM group_capacity GROUP BY day, shift_type_id, is_night
), daily_capacity AS (
  SELECT day,
    sum(assigned) FILTER (WHERE NOT is_night)::integer AS day_assigned,
    CASE WHEN bool_and(required IS NOT NULL) FILTER (WHERE NOT is_night)
      THEN sum(required) FILTER (WHERE NOT is_night)::integer END AS day_required,
    sum(assigned) FILTER (WHERE is_night)::integer AS night_assigned,
    CASE WHEN bool_and(required IS NOT NULL) FILTER (WHERE is_night)
      THEN sum(required) FILTER (WHERE is_night)::integer END AS night_required,
    bool_or(is_night AND assigned = 0 AND required > 0) AS night_missing
  FROM shift_capacity GROUP BY day
), patient_access AS (
  SELECT p.division_id, p.department_id FROM period p
  WHERE shiftly_api.fn_user_has_permission($2, 'screen:clinical_patient_administration:open')
    AND shiftly_api.fn_user_can_access_division_department($2, p.division_id, p.department_id)
), scoped_locations AS MATERIALIZED (
  -- Retain the historical evidence needed to distinguish an empty census from
  -- an unknown one, but do not materialize unused location details.
  SELECT l.encounter_id, l.started_at FROM shiftly_schema.clinical_encounter_locations l
  JOIN patient_access p ON p.division_id = l.division_id AND p.department_id = l.department_id
), relevant_encounters AS MATERIALIZED (
  SELECT e.* FROM shiftly_schema.clinical_encounters e
  CROSS JOIN period period_window CROSS JOIN business_clock clock
  WHERE e.encounter_status <> 'CANCELLED'
    AND e.admitted_at <= least(period_window.end_date + interval '1 day' - interval '1 microsecond', clock.now)
    AND (e.discharged_at IS NULL OR e.discharged_at > period_window.start_date - 7)
    AND (
    EXISTS (SELECT 1 FROM scoped_locations l WHERE l.encounter_id = e.id)
    OR EXISTS (SELECT 1 FROM patient_access p
      WHERE p.division_id = e.division_id AND p.department_id = e.department_id)
  )
), census_points AS (
  SELECT d.day, least(d.day + interval '1 day' - interval '1 microsecond',
    c.now) AS cutoff
  FROM dates d CROSS JOIN business_clock c
), encounter_presence AS (
  SELECT d.day, e.id,
    count(l.id) AS location_count,
    count(l.id) FILTER (WHERE l.division_id = p.division_id
      AND l.department_id = p.department_id) AS in_scope
  FROM census_points d CROSS JOIN patient_access p
  JOIN relevant_encounters e ON e.admitted_at <= d.cutoff
    AND (e.discharged_at IS NULL OR e.discharged_at > d.cutoff)
  LEFT JOIN shiftly_schema.clinical_encounter_locations l ON l.encounter_id = e.id
    AND l.started_at <= d.cutoff AND (l.ended_at IS NULL OR l.ended_at > d.cutoff)
  GROUP BY d.day, e.id
), daily_census AS (
  SELECT d.day,
    CASE WHEN d.day <= (SELECT now::date FROM business_clock)
      AND EXISTS (SELECT 1 FROM patient_access)
      AND EXISTS (SELECT 1 FROM scoped_locations l WHERE l.started_at <= d.cutoff)
      AND NOT EXISTS (SELECT 1 FROM encounter_presence e WHERE e.day = d.day AND e.location_count <> 1)
    THEN (SELECT count(*)::integer FROM encounter_presence e
      WHERE e.day = d.day AND e.location_count = 1 AND e.in_scope = 1) END AS patient_count
  FROM census_points d
), census_baseline AS (
  SELECT day, patient_count,
    CASE WHEN count(patient_count) OVER prior_days >= 3
      THEN avg(patient_count) OVER prior_days END AS baseline
  FROM daily_census
  WINDOW prior_days AS (ORDER BY day ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING)
), overview_days AS (
  SELECT d.day, c.day_assigned, c.day_required, c.night_assigned, c.night_required,
    COALESCE(c.night_missing, false) AS night_missing, b.patient_count,
    round(b.baseline, 1) AS patient_baseline,
    round(b.patient_count - b.baseline, 1) AS patient_delta,
    COALESCE(abs(b.patient_count - b.baseline) >= greatest(3, b.baseline * 0.2), false) AS patient_alert
  FROM period_days d
  LEFT JOIN daily_capacity c ON c.day = d.day
  LEFT JOIN census_baseline b ON b.day = d.day
)
SELECT jsonb_build_object(
  'period_id', p.id,
  'total_assignments', (SELECT count(*) FROM assignments),
  'patient_baseline_description',
    'Documented patient census at day end (today: now), compared with the previous 7 days; at least 3 known days are required. Alert: change of at least 3 patients and 20%. Future dates and incomplete location history are unavailable. Review the required staff override; no staffing change is applied automatically.',
  'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'date', to_char(d.day, 'YYYY-MM-DD'),
    'day_assigned', d.day_assigned, 'day_required', d.day_required,
    'night_assigned', d.night_assigned, 'night_required', d.night_required,
    'night_missing', d.night_missing,
    'patient_count', d.patient_count, 'patient_baseline', d.patient_baseline,
    'patient_delta', d.patient_delta, 'patient_alert', d.patient_alert
  ) ORDER BY d.day) FROM overview_days d), '[]'::jsonb)
) AS overview FROM period p;
`;

module.exports = { shiftPeriodOverviewSql };
