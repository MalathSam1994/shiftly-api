// query/switchCandidates.js
// GET /switch-candidates?source_assignment_id=11827&logged_user_id=2
// Uses DB view: shiftly_schema.v_switch_candidates_month

const express = require('express');
const router = express.Router();

// NOTE: adjust this import if your pool is exported from a different path
const pool = require('../db');

router.get('/', async (req, res) => {
  try {
    const qp = req.query || {};

    const rawSourceId = qp.source_assignment_id ?? qp.sourceAssignmentId;
    const sourceAssignmentId =
      rawSourceId != null && rawSourceId !== '' ? Number(rawSourceId) : null;

    const rawLoggedUserId = qp.logged_user_id ?? qp.loggedUserId;
    const loggedUserId =
      rawLoggedUserId != null && rawLoggedUserId !== ''
        ? Number(rawLoggedUserId)
        : null;

    if (!sourceAssignmentId || !Number.isFinite(sourceAssignmentId)) {
      return res.status(400).json({
        error: 'source_assignment_id is required and must be a number',
      });
    }

    if (!loggedUserId || !Number.isFinite(loggedUserId)) {
      return res.status(400).json({
        error: 'logged_user_id is required and must be a number',
      });
    }

    // IMPORTANT:
    // Stringify DATE fields explicitly to prevent timezone-based day shifts.
    const sql = `
      SELECT
        x.source_assignment_id,
        x.logged_user_id,
        x.candidate_assignment_id,
        to_char(x.shift_date, 'YYYY-MM-DD') AS shift_date,
        x.division_id,
        x.department_id,
        x.shift_type_id,
        x.colleague_user_id,
        x.user_display_name,
        x.status,
        x.status_comment,
        to_char(x.month_start, 'YYYY-MM-DD') AS month_start,
        to_char(x.month_end, 'YYYY-MM-DD') AS month_end
      FROM shiftly_api.fn_switch_candidates_month($1, $2) x
      ORDER BY x.shift_date ASC, x.candidate_assignment_id ASC
    `;

    const result = await pool.query(sql, [sourceAssignmentId, loggedUserId]);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /switch-candidates failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
