// shiftOffers.js
const express = require('express');
const pool = require('../db');

const router = express.Router();

function sendDbError(res, err, context) {
  const payload = {
    error: 'Database error',
    context: context || undefined,
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    constraint: err?.constraint,
    table: err?.table,
    column: err?.column,
    schema: err?.schema,
    routine: err?.routine,
    where: err?.where,
  };
  Object.keys(payload).forEach((k) => payload[k] == null && delete payload[k]);
  return res.status(500).json(payload);
}

function isAbsenceValue(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/**
 * GET /shift-offers
 *
 * Query:
 *  - requestorUserId (required) : the user who is browsing available offers
 *  - shiftDate (optional)       : YYYY-MM-DD
 *  - divisionId (optional)
 *  - departmentId (optional)
 *  - shiftTypeId (optional)
 *
 * Eligibility:
 *  - offer.status = 'ACTIVE'
 *  - offer.visibility_scope = 'ALL_ELIGIBLE'  OR offer.target_user_id = requestorUserId
 *  - requestor has same staff_type as assignment.staff_type_id
 *  - assignment division/department within requestor allowed divisions/departments
 *  - requestor cannot see/take their own offer
 */
router.get('/', async (req, res) => {
  try {
    const { requestorUserId, shiftDate, divisionId, departmentId, shiftTypeId } = req.query;

    const reqId = parseInt(String(requestorUserId ?? ''), 10);
    if (!reqId || Number.isNaN(reqId)) {
      return res.status(400).json({ error: 'requestorUserId is required' });
    }

    const values = [reqId];
    const where = [];

    if (shiftDate != null && String(shiftDate).trim() !== '') {
      values.push(String(shiftDate).trim());
      where.push(`sa.shift_date::date = $${values.length}::date`);
    }
    if (divisionId != null && String(divisionId).trim() !== '') {
      values.push(parseInt(String(divisionId), 10));
      where.push(`sa.division_id = $${values.length}`);
    }
    if (departmentId != null && String(departmentId).trim() !== '') {
      values.push(parseInt(String(departmentId), 10));
      where.push(`sa.department_id = $${values.length}`);
    }
    if (shiftTypeId != null && String(shiftTypeId).trim() !== '') {
      values.push(parseInt(String(shiftTypeId), 10));
      where.push(`sa.shift_type_id = $${values.length}`);
    }

    const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';

    const q = `
      WITH
      ctx AS (
        SELECT u.id AS user_id, u.staff_type_id
          FROM shiftly_schema.users u
         WHERE u.id = $1
      ),
      dept AS (
        SELECT department_id
          FROM shiftly_schema.user_department
         WHERE user_id = (SELECT user_id FROM ctx)
      ),
      divs AS (
        SELECT division_id
          FROM shiftly_schema.user_divisions
         WHERE user_id = (SELECT user_id FROM ctx)
      )
      SELECT
        so.id,
        so.shift_assignment_id,
        so.offered_by_user_id,
        so.offered_at,
        so.status,
        so.original_assignment_status,
        so.visibility_scope,
        so.target_user_id,
        so.note,

        -- assignment snapshot for UI
        sa.shift_date,
        sa.division_id,
        sa.department_id,
        sa.shift_type_id,
        sa.staff_type_id,
        sa.user_id AS assignment_owner_user_id,

        st.shift_label,
        st.start_time,
        st.end_time,
        st.duration_hours
      FROM shiftly_schema.shift_offers so
      JOIN shiftly_schema.shift_assignments sa
        ON sa.id = so.shift_assignment_id
      JOIN shiftly_schema.shift_types st
        ON st.id = sa.shift_type_id
      JOIN ctx
        ON ctx.staff_type_id = sa.staff_type_id
      WHERE so.status = 'ACTIVE'
        AND NOT (COALESCE(sa.is_absence::text, 'false') IN ('t','true','1'))
        AND sa.status = 'APPROVED'
        AND sa.user_id <> (SELECT user_id FROM ctx)              -- can't see own offer
        AND sa.department_id IN (SELECT department_id FROM dept) -- allowed depts
        AND sa.division_id   IN (SELECT division_id   FROM divs) -- allowed divs
        AND (
          so.visibility_scope = 'ALL_ELIGIBLE'
          OR so.target_user_id = (SELECT user_id FROM ctx)
        )
        ${whereSql}
      ORDER BY sa.shift_date DESC, st.start_time ASC, so.offered_at DESC
    `;

    const r = await pool.query(q, values);
    return res.json(r.rows);
  } catch (err) {
    console.error('Error querying DB (SHIFT OFFERS LIST):', err);
    return sendDbError(res, err, 'SHIFT OFFERS LIST');
  }
});

/**
 * POST /shift-offers
 *
 * Body:
 *  - shift_assignment_id (required)
 *  - offered_by_user_id  (required)  : must match assignment.user_id (owner)
 *  - note               (optional)
 *  - visibility_scope   (optional)   : ALL_ELIGIBLE | TARGET_USER (default ALL_ELIGIBLE)
 *  - target_user_id     (optional)   : required if visibility_scope = TARGET_USER
 *
 * IMPORTANT: UPSERT by shift_assignment_id to avoid uq_shift_offers_assignment crashes.
 */
router.post('/', async (req, res) => {
  let client;
  try {
    const {
      shift_assignment_id,
      offered_by_user_id,
      note,
      visibility_scope,
      target_user_id,
    } = req.body;

    const asgId = parseInt(String(shift_assignment_id ?? ''), 10);
    const byId = parseInt(String(offered_by_user_id ?? ''), 10);

    if (!asgId || Number.isNaN(asgId) || !byId || Number.isNaN(byId)) {
      return res.status(400).json({ error: 'shift_assignment_id and offered_by_user_id are required.' });
    }

    const scope = String(visibility_scope ?? 'ALL_ELIGIBLE').toUpperCase();
    if (!['ALL_ELIGIBLE', 'TARGET_USER'].includes(scope)) {
      return res.status(400).json({ error: 'visibility_scope must be ALL_ELIGIBLE or TARGET_USER.' });
    }

    const targetId = target_user_id == null ? null : parseInt(String(target_user_id), 10);
    if (scope === 'TARGET_USER' && (!targetId || Number.isNaN(targetId))) {
      return res.status(400).json({ error: 'target_user_id is required when visibility_scope = TARGET_USER.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Lock assignment
    const asgRes = await client.query(
      `SELECT * FROM shiftly_schema.shift_assignments WHERE id = $1 FOR UPDATE`,
      [asgId]
    );
    if (!asgRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'shift_assignment_id not found' });
    }
    const a = asgRes.rows[0];

    if (Number(a.user_id) !== Number(byId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the assignment owner can offer this shift.' });
    }
    if (isAbsenceValue(a.is_absence)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Absence assignments cannot be offered.' });
    }
    if (String(a.status).toUpperCase() !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only APPROVED assignments can be offered.' });
    }

    // If an offer exists and is TAKEN, do not allow re-offering
    const existing = await client.query(
      `SELECT * FROM shiftly_schema.shift_offers WHERE shift_assignment_id = $1 FOR UPDATE`,
      [asgId]
    );
    if (existing.rows.length && String(existing.rows[0].status).toUpperCase() === 'TAKEN') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This shift was already taken and cannot be offered again.' });
    }

    // UPSERT to avoid uq_shift_offers_assignment failure
    const upsert = await client.query(
      `
      INSERT INTO shiftly_schema.shift_offers (
        shift_assignment_id,
        offered_by_user_id,
        offered_at,
        status,
        original_assignment_status,
        target_user_id,
        visibility_scope,
        note
      )
      VALUES (
        $1,
        $2,
        NOW(),
        'ACTIVE',
        $3,
        $4,
        $5,
        $6
      )
      ON CONFLICT (shift_assignment_id)
      DO UPDATE SET
        offered_by_user_id = EXCLUDED.offered_by_user_id,
        offered_at = NOW(),
        status = 'ACTIVE',
        original_assignment_status = COALESCE(shiftly_schema.shift_offers.original_assignment_status, EXCLUDED.original_assignment_status),
        target_user_id = EXCLUDED.target_user_id,
        visibility_scope = EXCLUDED.visibility_scope,
        note = EXCLUDED.note
      RETURNING *
      `,
      [
        asgId,
        byId,
        a.status,
        targetId,
        scope,
        note ?? null,
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json(upsert.rows[0]);
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Error creating/updating shift offer:', err);
    return sendDbError(res, err, 'SHIFT OFFERS CREATE');
  } finally {
    if (client) client.release();
  }
});

module.exports = router;