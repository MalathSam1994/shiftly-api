const pool = require('../db');
const { scopedPeriodsWhere } = require('./shiftPeriodScope');

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

// Trigger timestamps are roster-local wall times. Do not convert them through
// the API host's timezone; retain both dates for an overnight conflict.
function rosterTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(match[2]) - 1];
  if (!month) return null;
  return {
    day: match[1] + '-' + match[2] + '-' + match[3],
    date: Number(match[3]) + ' ' + month + ' ' + match[1],
    time: match[4] + (match[5] && match[5] !== '00' ? ':' + match[5] : ''),
  };
}

function rosterInterval(startValue, endValue) {
  const start = rosterTimestamp(startValue), end = rosterTimestamp(endValue);
  if (!start || !end) return 'time details unavailable';
  return start.date + ', ' + start.time + ' - ' +
    (start.day === end.day ? '' : end.date + ', ') + end.time;
}

async function periodApprovalOverlapError(err, { periodId, userId }) {
  if (!err || err.code !== 'P0001') return null;
  let detail;
  try { detail = typeof err.detail === 'string' ? JSON.parse(err.detail) : err.detail; }
  catch (_) { detail = null; }
  if (detail?.code !== 'APPROVED_SHIFT_OVERLAP') return null;

  const answer = {
    status: 409,
    code: 'APPROVED_SHIFT_OVERLAP',
    error: 'Period approval blocked by overlapping shifts.',
    details: 'A staff member has overlapping shifts. Review the pending assignments and the staff member\'s existing schedule, then change or cancel the conflicting shift before trying again. No approvals were saved by this attempt.',
  };
  const requestedId = positiveId(detail.new_assignment_id);
  const conflictId = positiveId(detail.conflict_assignment_id);
  const staffId = positiveId(detail.user_id);
  if (!positiveId(userId) || !positiveId(periodId) || !requestedId || !conflictId || !staffId) return answer;

  try {
    const requestedScope = scopedPeriodsWhere('sp', 1);
    const conflictScope = scopedPeriodsWhere('conflicting_assignment', 1);
    const { rows } = await pool.query(
      `
      SELECT COALESCE(NULLIF(u.user_desc,''),u.user_name,'Staff member') AS staff_name,
        dv.division_desc AS division_name, dep.department_desc AS department_name,
        st.shift_label, blocking.*
      FROM shiftly_schema.shift_assignments requested
      JOIN shiftly_schema.shift_periods sp ON sp.id=requested.shift_period_id
      JOIN shiftly_schema.users u ON u.id=requested.user_id
      LEFT JOIN shiftly_schema.divisions dv ON dv.id=requested.division_id
      LEFT JOIN shiftly_schema.departments dep ON dep.id=requested.department_id
      LEFT JOIN shiftly_schema.shift_types st ON st.id=requested.shift_type_id
      LEFT JOIN LATERAL (
        SELECT conflicting_assignment.id AS conflict_id, conflicting_assignment.shift_period_id AS conflict_period_id,
          conflicting_assignment.status AS conflict_status, cdv.division_desc AS conflict_division,
          cdep.department_desc AS conflict_department, cst.shift_label AS conflict_shift_label
        FROM shiftly_schema.shift_assignments conflicting_assignment
        LEFT JOIN shiftly_schema.divisions cdv ON cdv.id=conflicting_assignment.division_id
        LEFT JOIN shiftly_schema.departments cdep ON cdep.id=conflicting_assignment.department_id
        LEFT JOIN shiftly_schema.shift_types cst ON cst.id=conflicting_assignment.shift_type_id
        WHERE conflicting_assignment.id=$5 AND conflicting_assignment.user_id=$4 AND ${conflictScope.sql}
      ) blocking ON true
      WHERE sp.id=$2 AND requested.id=$3 AND requested.user_id=$4
        AND requested.division_id=sp.division_id AND requested.department_id=sp.department_id
        AND ${requestedScope.sql}
        AND EXISTS(SELECT 1 FROM shiftly_schema.users actor WHERE actor.id=$1 AND actor.is_active)
      `,
      [userId, periodId, requestedId, staffId, conflictId],
    );
    const context = rows[0];
    if (!context) return answer;
    const requestedLabel = [context.division_name, context.department_name, context.shift_label]
      .filter(Boolean).join(' / ');
    const requestedTime = rosterInterval(detail.new_start_ts, detail.new_end_ts);
    let conflictText = 'The conflicting shift is no longer available or is outside your current access. Ask the responsible manager to review it.';
    if (context.conflict_id != null) {
      const conflictLabel = [context.conflict_division, context.conflict_department, context.conflict_shift_label]
        .filter(Boolean).join(' / ');
      const conflictTime = rosterInterval(detail.conflict_start_ts, detail.conflict_end_ts);
      // A bulk UPDATE can detect two pending rows. Both roll back, so do not
      // incorrectly describe the other row as already approved.
      const state = context.conflict_status === 'APPROVED' ? 'Already approved'
        : context.conflict_period_id === periodId && context.conflict_status !== 'CANCELLED'
          ? 'Also included in this approval' : 'Conflicting shift at the time of approval';
      conflictText = state + ': ' + conflictLabel + ' / ' + conflictTime + '.';
    }
    answer.details = context.staff_name + ' cannot be approved for overlapping shifts.\n\n' +
      'To approve: ' + requestedLabel + ' / ' + requestedTime + '.\n' + conflictText +
      '\n\nChange the times or cancel the incorrect assignment, then try approving the period again. ' +
      'Approval covers all non-cancelled shifts in this period. No approvals were saved by this attempt.';
  } catch (lookupError) {
    // Enrichment is best-effort. A lookup failure must not hide the known guard
    // reason or expose raw SQL detail in the response.
    console.warn('[period approval conflict details unavailable]', { periodId, code: lookupError.code });
  }
  return answer;
}

module.exports = { periodApprovalOverlapError };
