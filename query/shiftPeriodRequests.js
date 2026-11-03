const { scopedPeriodsWhere } = require('../utils/shiftPeriodScope');

// Shared by the lightweight request reader and calendar totals. The caller
// supplies an already-authorized `period` CTE and binds the actor as $2.
// Requests are workflow records, never synthetic shift_assignments.
const periodRequestCtes = `
request_candidates AS MATERIALIZED (
  SELECT sr.id, sr.request_type, sr.request_status, sr.requested_shift_date AS day,
    p.id AS period_id, p.division_id, p.department_id,
    sr.requested_shift_type_id AS shift_type_id,
    COALESCE(NULLIF(trim(st.shift_label), ''), st.shift_code, 'Shift ' || st.id) AS shift_label,
    CASE WHEN sr.request_type = 'NEW_SHIFT' THEN COALESCE(existing.staff_type_id, requester.staff_type_id)
      ELSE COALESCE(linked.staff_type_id, requester.staff_type_id) END AS staff_type_id,
    sr.requested_by_user_id AS user_id, requester.user_name, requester.user_desc,
    COALESCE(existing.start_time, st.start_time) AS start_time,
    COALESCE(existing.end_time, st.end_time) AS end_time,
    existing.id AS assignment_id, sr.inbox_user_id AS workflow_owner_user_id,
    sr.request_type = 'NEW_SHIFT' AND existing.id IS NULL AS prospective,
    row_number() OVER (PARTITION BY sr.requested_shift_date, sr.requested_shift_type_id,
      sr.requested_by_user_id, sr.request_type ORDER BY sr.id) AS candidate_rank
  FROM period p JOIN shiftly_schema.shift_requests sr
    ON sr.requested_department_id = p.department_id
    AND sr.requested_shift_date BETWEEN p.start_date AND p.end_date
    AND sr.inbox_user_id = $2 AND sr.request_status LIKE 'PENDING%'
  LEFT JOIN LATERAL (
    SELECT h.shift_assignment_id FROM shiftly_schema.shift_assignment_user_history h
    WHERE sr.request_type = 'NEW_SHIFT' AND h.shift_request_id = sr.id AND h.change_reason = 'NEW_SHIFT'
    ORDER BY h.id DESC LIMIT 1
  ) history ON true
  LEFT JOIN shiftly_schema.shift_assignments direct
    ON direct.id = COALESCE(sr.shift_assignment_id, history.shift_assignment_id)
  JOIN shiftly_schema.users requester ON requester.id = sr.requested_by_user_id
  JOIN shiftly_schema.shift_types st ON st.id = sr.requested_shift_type_id
  LEFT JOIN LATERAL (
    SELECT a.* FROM shiftly_schema.shift_assignments a
    WHERE a.id IN (direct.id, sr.source_shift_assignment_id, sr.target_shift_assignment_id)
      AND a.shift_date = sr.requested_shift_date AND a.shift_type_id = sr.requested_shift_type_id
      AND a.division_id = COALESCE(sr.division_id, direct.division_id)
      AND a.department_id = sr.requested_department_id
      AND (sr.request_type <> 'NEW_SHIFT' OR a.user_id = sr.requested_by_user_id)
    ORDER BY (a.id = direct.id) DESC NULLS LAST, a.id LIMIT 1
  ) linked ON true
  LEFT JOIN LATERAL (
    SELECT a.* FROM shiftly_schema.shift_assignments a
    WHERE a.shift_period_id = p.id AND a.shift_date = sr.requested_shift_date
      AND a.division_id = p.division_id AND a.department_id = p.department_id
      AND a.shift_type_id = sr.requested_shift_type_id
      AND COALESCE(a.is_absence, 2) <> 1 AND upper(COALESCE(a.status, '')) <> 'CANCELLED'
      AND CASE WHEN sr.request_type = 'NEW_SHIFT' THEN a.user_id = sr.requested_by_user_id
        ELSE a.id = linked.id END
    ORDER BY (a.id = linked.id) DESC NULLS LAST, a.id LIMIT 1
  ) existing ON true
  WHERE COALESCE(sr.division_id, direct.division_id) = p.division_id
    AND p.id = COALESCE(linked.shift_period_id,
      shiftly_api.find_active_shift_period_for_date(sr.requested_shift_date, p.division_id, p.department_id),
      (SELECT CASE WHEN count(*) = 1 THEN min(candidate.id) END
       FROM shiftly_schema.shift_periods candidate
       WHERE candidate.division_id = p.division_id AND candidate.department_id = p.department_id
         AND sr.requested_shift_date BETWEEN candidate.start_date AND candidate.end_date))
), period_requests AS MATERIALIZED (
  SELECT r.*, staff.staff_type_name,
    r.prospective AND r.candidate_rank = 1 AS counts_as_place,
    COALESCE(capacity.required_staff_count, rule.required_staff_count) AS required_staff_count
  FROM request_candidates r
  LEFT JOIN shiftly_schema.staff_types staff ON staff.id = r.staff_type_id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(*) = 1 THEN min(g.required_staff_count) END AS required_staff_count
    FROM shiftly_schema.shift_assignment_capacity_groups g
    WHERE g.shift_period_id = r.period_id AND g.shift_date = r.day
      AND g.division_id = r.division_id AND g.department_id = r.department_id
      AND g.staff_type_id IS NOT DISTINCT FROM r.staff_type_id AND g.shift_type_id = r.shift_type_id
  ) capacity ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(*) = 1 THEN min(rule.required_staff_count) END AS required_staff_count
    FROM shiftly_schema.staff_shift_rules rule
    WHERE rule.is_active AND rule.division_id = r.division_id AND rule.department_id = r.department_id
      AND rule.staff_type_id IS NOT DISTINCT FROM r.staff_type_id AND rule.shift_type_id = r.shift_type_id
  ) rule ON true
)
`;

const shiftPeriodRequestsSql = `
WITH period AS MATERIALIZED (
  SELECT p.* FROM shiftly_schema.shift_periods p
  WHERE p.id = $1 AND ${scopedPeriodsWhere('p', 2).sql}
), ${periodRequestCtes}
SELECT jsonb_build_object('period_id', p.id, 'requests', COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', r.id, 'request_type', r.request_type, 'request_status', r.request_status,
    'shift_date', to_char(r.day, 'YYYY-MM-DD'), 'division_id', r.division_id,
    'department_id', r.department_id, 'shift_type_id', r.shift_type_id, 'shift_label', r.shift_label,
    'staff_type_id', r.staff_type_id, 'staff_type_name', r.staff_type_name,
    'user_id', r.user_id, 'user_name', r.user_name, 'user_desc', r.user_desc,
    'start_time', to_char(r.start_time, 'HH24:MI:SS'), 'end_time', to_char(r.end_time, 'HH24:MI:SS'),
    'assignment_id', r.assignment_id, 'counts_as_place', r.counts_as_place,
    'workflow_owner_user_id', r.workflow_owner_user_id, 'required_staff_count', r.required_staff_count
  ) ORDER BY r.day, r.start_time, r.shift_type_id, r.staff_type_id, r.user_name, r.id)
  FROM period_requests r
), '[]'::jsonb)) AS payload FROM period p;
`;

module.exports = { periodRequestCtes, shiftPeriodRequestsSql };
