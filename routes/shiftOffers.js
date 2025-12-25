// routes/shiftOffers.js
const express = require('express');
const pool = require('./db');

const router = express.Router();

/**
 * Helper: time overlap check between two shift_types (assumes same-day ranges).
 * Overlap if: NOT (a_end <= b_start OR b_end <= a_start)
 */
function overlapsTime(aStart, aEnd, bStart, bEnd) {
  return !(aEnd <= bStart || bEnd <= aStart);
}

async function getPrimaryManagerId(client, userId) {
  const r = await client.query(
    `
    SELECT manager_user_id
      FROM shiftly_schema.user_managers
     WHERE user_id = $1
       AND is_primary = TRUE
     ORDER BY id
     LIMIT 1
    `,
    [userId]
  );
  return r.rows.length ? r.rows[0].manager_user_id : null;
}

async function userHasOverlappingAssignment(client, { userId, shiftDate, shiftTypeId, excludeAssignmentId = null }) {
  const r = await client.query(
    `
    SELECT 1
      FROM shiftly_schema.shift_assignments sa
      JOIN shiftly_schema.shift_types st_existing ON st_existing.id = sa.shift_type_id
      JOIN shiftly_schema.shift_types st_new      ON st_new.id = $3
     WHERE sa.user_id = $1
       AND sa.shift_date = $2
       AND COALESCE(sa.is_absence, FALSE) = FALSE
       AND sa.status NOT IN ('CANCELLED')
       AND ($4::int IS NULL OR sa.id <> $4)
       AND NOT (st_existing.end_time <= st_new.start_time OR st_new.end_time <= st_existing.start_time)
     LIMIT 1
    `,
    [userId, shiftDate, shiftTypeId, excludeAssignmentId]
  );
  return r.rows.length > 0;
}

/**
 * GET /shift-offers
 * Query:
 *  - shiftDate (YYYY-MM-DD) optional
 *  - divisionId, departmentId, shiftTypeId, staffTypeId optional
 *  - excludeUserId optional (hide offers from that user)
 *  - requestorUserId optional (server validates overlap for requestor and filters invalid offers)
 */
router.get('/', async (req, res) => {
  try {
    const qp = req.query || {};
    const shiftDate = (qp.shiftDate ?? qp.shift_date ?? '').toString().trim();
    const divisionId = qp.divisionId ?? qp.division_id;
    const departmentId = qp.departmentId ?? qp.department_id;
    const shiftTypeId = qp.shiftTypeId ?? qp.shift_type_id;
    const staffTypeId = qp.staffTypeId ?? qp.staff_type_id;
    const excludeUserId = qp.excludeUserId ?? qp.exclude_user_id;
    const requestorUserId = qp.requestorUserId ?? qp.requestor_user_id;

    const where = [`so.status = 'ACTIVE'`];
    const params = [];
    let i = 1;

    if (shiftDate) { params.push(shiftDate); where.push(`sa.shift_date = $${i++}`); }
    if (divisionId != null && String(divisionId).trim() !== '') { params.push(Number(divisionId)); where.push(`sa.division_id = $${i++}`); }
    if (departmentId != null && String(departmentId).trim() !== '') { params.push(Number(departmentId)); where.push(`sa.department_id = $${i++}`); }
    if (shiftTypeId != null && String(shiftTypeId).trim() !== '') { params.push(Number(shiftTypeId)); where.push(`sa.shift_type_id = $${i++}`); }
    if (staffTypeId != null && String(staffTypeId).trim() !== '') { params.push(Number(staffTypeId)); where.push(`sa.staff_type_id = $${i++}`); }
    if (excludeUserId != null && String(excludeUserId).trim() !== '') { params.push(Number(excludeUserId)); where.push(`so.offered_by_user_id <> $${i++}`); }

    const sql = `
      SELECT
        so.id,
        so.shift_assignment_id,
        so.offered_by_user_id,
        so.offered_at,
        so.status,
        so.note,
        sa.shift_date,
        sa.division_id,
        sa.department_id,
        sa.shift_type_id,
        sa.staff_type_id,
        sa.user_id AS current_assignment_user_id
      FROM shiftly_schema.shift_offers so
      JOIN shiftly_schema.shift_assignments sa
        ON sa.id = so.shift_assignment_id
      WHERE ${where.join(' AND ')}
      ORDER BY sa.shift_date ASC, so.offered_at DESC
    `;

    const result = await pool.query(sql, params);
    let rows = result.rows;

    // Optional: filter out offers that would overlap the requestor's existing assignments
    if (requestorUserId != null && String(requestorUserId).trim() !== '') {
      const requestorId = Number(requestorUserId);
      const client = await pool.connect();
      try {
        const filtered = [];
        for (const r of rows) {
          const hasOverlap = await userHasOverlappingAssignment(client, {
            userId: requestorId,
            shiftDate: r.shift_date,
            shiftTypeId: r.shift_type_id,
          });
          if (!hasOverlap) filtered.push(r);
        }
        rows = filtered;
      } finally {
        client.release();
      }
    }

    res.json(rows);
  } catch (err) {
    console.error('Error listing shift offers:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /shift-offers
 * Body:
 *  - shift_assignment_id (required)
 *  - offered_by_user_id (required)
 *  - note (optional)
 *
 * Effects:
 *  - shift_assignments.status -> 'OFFERED'
 *  - insert shift_offers row ACTIVE (unique per assignment)
 */
router.post('/', async (req, res) => {
  let client;
  try {
    const { shift_assignment_id, offered_by_user_id, note } = req.body;
    if (!shift_assignment_id || !offered_by_user_id) {
      return res.status(400).json({ error: 'shift_assignment_id and offered_by_user_id are required.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const a = await client.query(
      `
      SELECT *
        FROM shiftly_schema.shift_assignments
       WHERE id = $1
       FOR UPDATE
      `,
      [shift_assignment_id]
    );
    if (!a.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift assignment not found.' });
    }
    const assignment = a.rows[0];

    if (Number(assignment.user_id) !== Number(offered_by_user_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only offer your own assignment.' });
    }
    if (assignment.is_absence === true) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Absence assignments cannot be offered.' });
    }

    // Create offer row (unique per assignment)
    const offerInsert = await client.query(
      `
      INSERT INTO shiftly_schema.shift_offers (
        shift_assignment_id,
        offered_by_user_id,
        offered_at,
        status,
        original_assignment_status,
        note
      )
      VALUES ($1, $2, NOW(), 'ACTIVE', $3, $4)
      ON CONFLICT (shift_assignment_id)
      DO UPDATE SET
        offered_by_user_id = EXCLUDED.offered_by_user_id,
        offered_at = NOW(),
        status = 'ACTIVE',
        note = EXCLUDED.note
      RETURNING *
      `,
      [shift_assignment_id, offered_by_user_id, assignment.status, note ?? null]
    );

    // Mark assignment as OFFERED
    await client.query(
      `
      UPDATE shiftly_schema.shift_assignments
         SET status = 'OFFERED',
             updated_at = NOW()
       WHERE id = $1
      `,
      [shift_assignment_id]
    );

    await client.query('COMMIT');
    res.status(201).json(offerInsert.rows[0]);
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Error creating shift offer:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

/**
 * POST /shift-offers/:id/cancel
 * Body:
 *  - cancelled_by_user_id (required)
 */
router.post('/:id/cancel', async (req, res) => {
  let client;
  try {
    const offerId = Number(req.params.id);
    const { cancelled_by_user_id } = req.body;
    if (!cancelled_by_user_id) {
      return res.status(400).json({ error: 'cancelled_by_user_id is required.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const o = await client.query(
      `
      SELECT so.*, sa.status AS assignment_status
        FROM shiftly_schema.shift_offers so
        JOIN shiftly_schema.shift_assignments sa ON sa.id = so.shift_assignment_id
       WHERE so.id = $1
       FOR UPDATE
      `,
      [offerId]
    );
    if (!o.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Offer not found.' });
    }
    const offer = o.rows[0];

    if (offer.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Offer is not ACTIVE (current=${offer.status}).` });
    }

    // Only the offering user (or their manager) should cancel.
    const managerId = await getPrimaryManagerId(client, offer.offered_by_user_id);
    const actor = Number(cancelled_by_user_id);
    if (actor !== Number(offer.offered_by_user_id) && (managerId == null || actor !== Number(managerId))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not allowed to cancel this offer.' });
    }

    await client.query(
      `
      UPDATE shiftly_schema.shift_offers
         SET status = 'CANCELLED',
             cancelled_by_user_id = $1,
             cancelled_at = NOW()
       WHERE id = $2
       RETURNING *
      `,
      [cancelled_by_user_id, offerId]
    );

    // Restore assignment status (fallback to APPROVED)
    const restoreStatus = offer.original_assignment_status || 'APPROVED';
    await client.query(
      `
      UPDATE shiftly_schema.shift_assignments
         SET status = $1,
             updated_at = NOW()
       WHERE id = $2
      `,
      [restoreStatus, offer.shift_assignment_id]
    );

    await client.query('COMMIT');
    res.json({ cancelled: true });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Error cancelling shift offer:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;