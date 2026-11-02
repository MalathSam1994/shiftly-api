const { scopedPeriodsWhere } = require('../utils/shiftPeriodScope');

// One read-only snapshot: $1 = period, $2 = authenticated actor, $3 = business timezone.
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
), named_types AS (
  SELECT st.*, COALESCE(NULLIF(trim(st.shift_label), ''), NULLIF(trim(st.shift_code), ''), 'Shift ' || st.id) AS label,
    lower(COALESCE(st.shift_label, '') || ' ' || COALESCE(st.shift_code, '')) AS name_key
  FROM shiftly_schema.shift_types st
), categorized_types AS (
  SELECT st.*, CASE
    WHEN name_key ~ '(^|[^a-z])(morning|early)([^a-z]|$)' THEN 'morning'
    WHEN name_key ~ '(^|[^a-z])(afternoon)([^a-z]|$)' THEN 'afternoon'
    WHEN name_key ~ '(^|[^a-z])(evening|late)([^a-z]|$)' THEN 'evening'
    WHEN name_key ~ '(^|[^a-z])(night|overnight)([^a-z]|$)' THEN 'night'
    WHEN name_key ~ '(^|[^a-z])(day)([^a-z]|$)' THEN 'day'
    WHEN trim(name_key) <> '' THEN 'other'
    WHEN end_time <= start_time OR start_time >= time '18:00' OR start_time < time '06:00' THEN 'night'
    ELSE 'day' END AS category
  FROM named_types st
), shift_kinds AS MATERIALIZED (
  SELECT st.*, CASE WHEN category = 'other' THEN 'custom:' || id ELSE category END AS category_key,
    category = 'night' AS is_night
  FROM categorized_types st
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
  WHERE COALESCE(a.is_absence, 2) <> 1 AND upper(COALESCE(a.status, '')) <> 'CANCELLED'
), saved_groups AS MATERIALIZED (
  SELECT g.* FROM shiftly_schema.shift_assignment_capacity_groups g
  JOIN period p ON p.id = g.shift_period_id
    AND p.division_id = g.division_id AND p.department_id = g.department_id
), explicit_keys AS (
  SELECT g.shift_date AS day, g.staff_type_id, g.shift_type_id, st.category_key
  FROM saved_groups g JOIN shift_kinds st ON st.id = g.shift_type_id
  UNION
  SELECT a.shift_date, a.staff_type_id, a.shift_type_id, st.category_key
  FROM assignments a JOIN shift_kinds st ON st.id = a.shift_type_id
), period_evidence AS (
  SELECT DISTINCT staff_type_id, shift_type_id, category_key FROM explicit_keys
), eligible_candidates AS (
  SELECT d.day, e.staff_type_id, e.shift_type_id, st.category_key, true AS from_period
  FROM period_days d CROSS JOIN period_evidence e JOIN shift_kinds st ON st.id = e.shift_type_id
  WHERE st.day_type = 'ANY'
    OR (st.day_type = 'WEEKDAY_ONLY' AND extract(isodow FROM d.day) < 6)
    OR (st.day_type = 'WEEKEND_ONLY' AND extract(isodow FROM d.day) >= 6)
  UNION ALL
  SELECT d.day, r.staff_type_id, r.shift_type_id, st.category_key, false
  FROM period_days d CROSS JOIN rules r JOIN shift_kinds st ON st.id = r.shift_type_id
  WHERE st.day_type = 'ANY'
    OR (st.day_type = 'WEEKDAY_ONLY' AND extract(isodow FROM d.day) < 6)
    OR (st.day_type = 'WEEKEND_ONLY' AND extract(isodow FROM d.day) >= 6)
), preferred_candidates AS (
  -- A roster's real shift pattern beats unrelated allowed rule alternatives.
  SELECT c.* FROM eligible_candidates c
  WHERE c.from_period OR NOT EXISTS (
    SELECT 1 FROM eligible_candidates e
    WHERE e.day = c.day AND e.category_key = c.category_key AND e.from_period
  )
), candidate_kinds AS (
  SELECT c.day, c.category_key, count(DISTINCT c.shift_type_id) AS type_count, bool_or(c.from_period) AS from_period,
    bool_or(r.required IS NULL OR r.required > 0) AS expects_staff
  FROM preferred_candidates c LEFT JOIN rules r ON r.shift_type_id = c.shift_type_id
    AND r.staff_type_id IS NOT DISTINCT FROM c.staff_type_id
  GROUP BY c.day, c.category_key
), group_keys AS (
  SELECT day, staff_type_id, shift_type_id, false AS inferred FROM explicit_keys
  UNION
  SELECT c.day, c.staff_type_id, c.shift_type_id, true FROM preferred_candidates c
  JOIN candidate_kinds k USING (day, category_key)
  WHERE k.type_count = 1 AND NOT EXISTS (
    SELECT 1 FROM explicit_keys e WHERE e.day = c.day AND e.category_key = c.category_key
  )
), group_capacity AS (
  SELECT k.day, k.shift_type_id, st.category, st.category_key, st.label, st.start_time, st.end_time,
    st.is_night, k.inferred, COALESCE(g.required_staff_count, r.required) AS required,
    shiftly_api.fn_roster_occupied_places(p.id, k.day, p.division_id, p.department_id, k.staff_type_id, k.shift_type_id) AS assigned
  FROM group_keys k CROSS JOIN period p JOIN shift_kinds st ON st.id = k.shift_type_id
  LEFT JOIN saved_groups g ON g.shift_date = k.day
    AND g.staff_type_id IS NOT DISTINCT FROM k.staff_type_id AND g.shift_type_id = k.shift_type_id
  LEFT JOIN rules r ON r.staff_type_id IS NOT DISTINCT FROM k.staff_type_id AND r.shift_type_id = k.shift_type_id
), typed_capacity AS (
  SELECT day, shift_type_id, category, category_key, label, start_time, end_time, is_night,
    bool_and(inferred) AS inferred, sum(assigned)::integer AS assigned,
    CASE WHEN bool_and(required IS NOT NULL) THEN sum(required)::integer END AS required
  FROM group_capacity GROUP BY day, shift_type_id, category, category_key, label, start_time, end_time, is_night
), shift_capacity AS (
  SELECT *, assigned = 0 AND (required > 0 OR required IS NULL) AS missing FROM typed_capacity
  UNION ALL
  -- Multiple alternatives in a known period category mean the shift is absent,
  -- but do not invent a type or sum its possible required counts.
  SELECT k.day, NULL::integer, k.category_key, k.category_key, initcap(k.category_key),
    NULL::time, NULL::time, k.category_key = 'night', true, 0, NULL::integer, k.from_period AND k.expects_staff
  FROM candidate_kinds k
  WHERE k.type_count > 1 AND NOT EXISTS (
    SELECT 1 FROM explicit_keys e WHERE e.day = k.day AND e.category_key = k.category_key
  )
), daily_capacity AS (
  SELECT day,
    sum(assigned) FILTER (WHERE NOT is_night)::integer AS day_assigned,
    CASE WHEN bool_and(required IS NOT NULL) FILTER (WHERE NOT is_night)
      THEN sum(required) FILTER (WHERE NOT is_night)::integer END AS day_required,
    sum(assigned) FILTER (WHERE is_night)::integer AS night_assigned,
    CASE WHEN bool_and(required IS NOT NULL) FILTER (WHERE is_night)
      THEN sum(required) FILTER (WHERE is_night)::integer END AS night_required,
    bool_or(is_night AND missing) AS night_missing,
    jsonb_agg(jsonb_build_object('shift_type_id', shift_type_id, 'label', label, 'category', category,
      'start_time', to_char(start_time, 'HH24:MI'), 'end_time', to_char(end_time, 'HH24:MI'),
      'assigned', assigned, 'required', required, 'missing', missing, 'inferred', inferred)
      ORDER BY start_time NULLS LAST, label, shift_type_id) AS shifts
  FROM shift_capacity GROUP BY day
), organization_intervals AS NOT MATERIALIZED (
  -- Actual assignment times are authoritative, including edited overnight ends.
  SELECT a.id, a.shift_date, st.label,
    a.shift_date + COALESCE(a.start_time, st.start_time) AS starts_at,
    a.shift_date + COALESCE(a.end_time, st.end_time) + CASE
      WHEN COALESCE(a.end_time, st.end_time) <= COALESCE(a.start_time, st.start_time)
      THEN interval '1 day' ELSE interval '0' END AS ends_at
  FROM shiftly_schema.shift_assignments a JOIN period p
    ON a.division_id = p.division_id AND a.department_id = p.department_id
  JOIN shift_kinds st ON st.id = a.shift_type_id
  WHERE a.shift_date <= p.end_date AND COALESCE(a.is_absence, 2) <> 1
    AND upper(COALESCE(a.status, '')) <> 'CANCELLED'
), spillovers AS (
  SELECT d.day, count(a.id)::integer AS count, to_char(max(a.ends_at), 'HH24:MI') AS until
  FROM period_days d JOIN organization_intervals a
    ON a.shift_date = d.day - 1 AND a.starts_at < d.day AND a.ends_at > d.day
  GROUP BY d.day
), selected_cutoffs AS (
  SELECT d.day, CASE WHEN d.day <= c.now::date
    THEN least(d.day + interval '1 day' - interval '1 microsecond', c.now) END AS cutoff
  FROM period_days d CROSS JOIN business_clock c
), last_shifts AS (
  SELECT d.day, a.ends_at AS cutoff, a.label
  FROM selected_cutoffs d LEFT JOIN LATERAL (
    SELECT ends_at, label FROM organization_intervals a
    WHERE a.shift_date <= d.day AND a.ends_at <= d.cutoff
    ORDER BY a.ends_at DESC, a.id DESC LIMIT 1
  ) a ON true
), patient_access AS (
  SELECT p.division_id, p.department_id FROM period p
  WHERE shiftly_api.fn_user_has_permission($2, 'screen:clinical_patient_administration:open')
    AND shiftly_api.fn_user_can_access_division_department($2, p.division_id, p.department_id)
), scoped_locations AS MATERIALIZED (
  SELECT l.encounter_id, l.started_at FROM shiftly_schema.clinical_encounter_locations l
  JOIN patient_access p ON p.division_id = l.division_id AND p.department_id = l.department_id
), census_points AS MATERIALIZED (
  SELECT 'day:' || d.day AS key, CASE WHEN d.day <= c.now::date
    THEN least(d.day + interval '1 day' - interval '1 microsecond', c.now) END AS cutoff
  FROM dates d CROSS JOIN business_clock c
  UNION ALL SELECT 'shift:' || day, cutoff FROM last_shifts
  UNION ALL SELECT 'live', now FROM business_clock
), relevant_encounters AS MATERIALIZED (
  SELECT e.* FROM shiftly_schema.clinical_encounters e
  WHERE e.encounter_status <> 'CANCELLED' AND EXISTS (
    SELECT 1 FROM census_points p WHERE p.cutoff IS NOT NULL AND e.admitted_at <= p.cutoff
      AND (e.discharged_at IS NULL OR e.discharged_at > p.cutoff)
  ) AND (
    EXISTS (SELECT 1 FROM scoped_locations l WHERE l.encounter_id = e.id)
    OR EXISTS (SELECT 1 FROM patient_access p WHERE p.division_id = e.division_id AND p.department_id = e.department_id)
  )
), encounter_presence AS (
  SELECT d.key, e.id, count(l.id) AS location_count,
    count(l.id) FILTER (WHERE l.division_id = p.division_id AND l.department_id = p.department_id) AS in_scope
  FROM census_points d CROSS JOIN patient_access p
  JOIN relevant_encounters e ON e.admitted_at <= d.cutoff
    AND (e.discharged_at IS NULL OR e.discharged_at > d.cutoff)
  LEFT JOIN shiftly_schema.clinical_encounter_locations l ON l.encounter_id = e.id
    AND l.started_at <= d.cutoff AND (l.ended_at IS NULL OR l.ended_at > d.cutoff)
  GROUP BY d.key, e.id
), point_census AS (
  SELECT d.key, d.cutoff, CASE WHEN d.cutoff IS NOT NULL
    AND EXISTS (SELECT 1 FROM patient_access)
    AND EXISTS (SELECT 1 FROM scoped_locations l WHERE l.started_at <= d.cutoff)
    AND NOT EXISTS (SELECT 1 FROM encounter_presence e WHERE e.key = d.key AND e.location_count <> 1)
    THEN (SELECT count(*)::integer FROM encounter_presence e
      WHERE e.key = d.key AND e.location_count = 1 AND e.in_scope = 1) END AS patient_count
  FROM census_points d
), census_baseline AS (
  SELECT d.day, c.patient_count,
    CASE WHEN count(c.patient_count) OVER prior_days >= 3 THEN avg(c.patient_count) OVER prior_days END AS baseline
  FROM dates d LEFT JOIN point_census c ON c.key = 'day:' || d.day
  WINDOW prior_days AS (ORDER BY d.day ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING)
), comparison_keys AS (
  SELECT d.day, x.* FROM period_days d CROSS JOIN LATERAL (VALUES
    (1, 'days_3', '3 days earlier', 'day:' || (d.day - 3)),
    (2, 'days_2', '2 days earlier', 'day:' || (d.day - 2)),
    (3, 'day_1', 'Previous day', 'day:' || (d.day - 1)),
    (4, 'last_shift', 'Last shift', 'shift:' || d.day),
    (5, 'selected_day', 'Selected day', 'day:' || d.day),
    (6, 'live_now', 'Live now', 'live')
  ) x(position, key, label, point_key)
), comparisons AS (
  SELECT k.day, jsonb_agg(jsonb_build_object(
    'key', k.key, 'label', k.label, 'count', c.patient_count,
    'observed_at', to_char(c.cutoff, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'shift_label', CASE WHEN k.key = 'last_shift' THEN l.label END
  ) ORDER BY k.position) AS rows
  FROM comparison_keys k LEFT JOIN point_census c ON c.key = k.point_key
  LEFT JOIN last_shifts l ON l.day = k.day GROUP BY k.day
), overview_days AS (
  SELECT d.day, c.day_assigned, c.day_required, c.night_assigned, c.night_required,
    COALESCE(c.night_missing, false) AS night_missing, COALESCE(c.shifts, '[]'::jsonb) AS shifts,
    COALESCE(s.count, 0) AS spillover_count, s.until AS spillover_until,
    COALESCE(s.count, 0) > 0 AND NOT EXISTS (SELECT 1 FROM organization_intervals a WHERE a.shift_date = d.day) AS spillover_only,
    b.patient_count, round(b.baseline, 1) AS patient_baseline,
    round(b.patient_count - b.baseline, 1) AS patient_delta,
    COALESCE(abs(b.patient_count - b.baseline) >= greatest(3, b.baseline * 0.2), false) AS patient_alert,
    m.rows AS patient_comparisons
  FROM period_days d LEFT JOIN daily_capacity c ON c.day = d.day
  LEFT JOIN spillovers s ON s.day = d.day LEFT JOIN census_baseline b ON b.day = d.day
  LEFT JOIN comparisons m ON m.day = d.day
)
SELECT jsonb_build_object(
  'period_id', p.id, 'total_assignments', (SELECT count(*) FROM assignments),
  'patient_baseline_description',
    'Patient alerts compare the observed selected-day census with the previous 7 days, requiring 3 known days and a change of at least 3 patients and 20%. The comparison table contains snapshots at the displayed business-local times; Live now is current even for a historical selected day.',
  'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'date', to_char(d.day, 'YYYY-MM-DD'),
    'day_assigned', d.day_assigned, 'day_required', d.day_required,
    'night_assigned', d.night_assigned, 'night_required', d.night_required,
    'night_missing', d.night_missing, 'shifts', d.shifts,
    'spillover_count', d.spillover_count, 'spillover_until', d.spillover_until, 'spillover_only', d.spillover_only,
    'patient_count', d.patient_count, 'patient_baseline', d.patient_baseline,
    'patient_delta', d.patient_delta, 'patient_alert', d.patient_alert, 'patient_comparisons', d.patient_comparisons
  ) ORDER BY d.day) FROM overview_days d), '[]'::jsonb)
) AS overview FROM period p;
`;

module.exports = { shiftPeriodOverviewSql };
