
const express = require('express');
const pool = require('../db');

const router = express.Router();


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

function isPendingStatus(status) {
  return typeof status === 'string' && status.toUpperCase().startsWith('PENDING');
}




/**
 * GET /shift-requests
 *
 * Optional query parameters:
 *  - managerUserId: show items for this manager (either directly assigned via manager_user_id
 *    OR where this manager is the primary manager in shiftly_schema.user_managers).
 *  - requestedByUserId: filter by the requesting user id.
 *  - requestStatus: filter by status (PENDING, APPROVED, REJECTED, ...).
 */
router.get('/', async (req, res) => {
  try {
 const { managerUserId, inboxUserId, requestedByUserId, requestStatus, divisionId } = req.query;

    const whereClauses = [];
    const values = [];

    if (requestedByUserId) {
      values.push(parseInt(requestedByUserId, 10));
      whereClauses.push(`sr.requested_by_user_id = $${values.length}`);
    }

    if (requestStatus) {
      values.push(requestStatus);
      whereClauses.push(`sr.request_status = $${values.length}`);
    }

    if (divisionId) {
      const divId = parseInt(divisionId, 10);
      values.push(divId);
      const index = values.length;
      // Prefer sr.division_id; fallback to assignment.division_id for older rows
      whereClauses.push(`COALESCE(sr.division_id, sa.division_id) = $${index}`);
    }



    const effectiveInboxUserId = inboxUserId ?? managerUserId;
    if (effectiveInboxUserId) {
      const actorId = parseInt(effectiveInboxUserId, 10);
      values.push(managerId);
      const index = values.length;

    
       // NEW: Match by inbox_user_id (this is the "who should act next" inbox)
      // Fallback: legacy manager_user_id OR via user_managers mapping (older rows).

      whereClauses.push(
     `(sr.inbox_user_id = $${index}
           OR sr.manager_user_id = $${index}
           OR EXISTS (
             SELECT 1
               FROM shiftly_schema.user_managers um
              WHERE um.user_id = sr.requested_by_user_id
                AND um.manager_user_id = $${index}
                AND um.is_primary = TRUE
           ))`
      );
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      SELECT
        sr.id,
        sr.request_type,
        sr.request_status,
        sr.requested_by_user_id,
        sr.target_user_id,
        sr.manager_user_id,
         sr.inbox_user_id,
        sr.shift_assignment_id,
        sr.source_shift_assignment_id,
        sr.target_shift_assignment_id,
        sr.shift_offer_id,
		COALESCE(sr.division_id, sa.division_id) AS division_id,
        sr.requested_shift_date,
        sr.requested_shift_type_id,
        sr.requested_department_id,
        sr.created_at,
        sr.decided_at,
        sr.decision_by_user_id,
        sr.decision_comment,
        sr.last_action_at,
        sr.last_action_by_user_id
      FROM shiftly_schema.shift_requests sr
	        LEFT JOIN shiftly_schema.shift_assignments sa
        ON sa.id = sr.shift_assignment_id
      ${whereSql}
      ORDER BY sr.created_at DESC
    `;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error('Error querying DB (SHIFT REQUESTS LIST):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * POST /shift-requests
 *
 * Body:
 *  - request_type (required)
 *  - requested_by_user_id (required)
 *  - target_user_id (optional)
 *  - manager_user_id (optional – if missing, we try to derive it from user_managers)
 *  - shift_assignment_id (optional)
 *  - source_shift_assignment_id (SWITCH/OFFER)
 *  - target_shift_assignment_id (SWITCH)
 *  - shift_offer_id (OFFER)
 *  - requested_shift_date (required, YYYY-MM-DD)
 *  - requested_shift_type_id (required)
 *  - requested_department_id (required)
 *  - division_id (optional but recommended; used for filtering & assignment creation)
 *  - decision_comment (optional, used here as "request comment" from employee)
 */
router.post('/', async (req, res) => {
  let client;
  try {
    const {
      request_type,
      requested_by_user_id,
      target_user_id,
      manager_user_id,
      shift_assignment_id,
       source_shift_assignment_id,
      target_shift_assignment_id,
      shift_offer_id,
	  division_id,
	  divisionId,
      requested_shift_date,
      requested_shift_type_id,
      requested_department_id,
      decision_comment,
    } = req.body;

      if (!request_type || !requested_by_user_id) {
      return res.status(400).json({ error: 'request_type and requested_by_user_id are required.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const effectiveDivisionId = division_id ?? divisionId ?? null;
    const typeUpper = String(request_type).toUpperCase();

    // ---- NEW_SHIFT (legacy) ----
    if (typeUpper === 'NEW_SHIFT') {
      if (!requested_shift_date || !requested_shift_type_id || !requested_department_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'NEW_SHIFT requires requested_shift_date, requested_shift_type_id and requested_department_id.',
        });
      }

      let effectiveManagerId = manager_user_id ?? null;
      if (!effectiveManagerId) {
        effectiveManagerId = await getPrimaryManagerId(client, requested_by_user_id);
      }

      const insertQuery = `
        INSERT INTO shiftly_schema.shift_requests (
          request_type,
          request_status,
          requested_by_user_id,
          target_user_id,
          manager_user_id,
          inbox_user_id,
          shift_assignment_id,
          division_id,
          requested_shift_date,
          requested_shift_type_id,
          requested_department_id,
          created_at,
          decided_at,
          decision_by_user_id,
          decision_comment
        )
        VALUES (
          $1,
          'PENDING',
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          NOW(),
          NULL,
          NULL,
          $10
        )
        RETURNING
          id, request_type, request_status, requested_by_user_id, target_user_id,
          manager_user_id, inbox_user_id, shift_assignment_id, division_id,
          requested_shift_date, requested_shift_type_id, requested_department_id,
          created_at, decided_at, decision_by_user_id, decision_comment,
          source_shift_assignment_id, target_shift_assignment_id, shift_offer_id,
          last_action_at, last_action_by_user_id
      `;

      const insertValues = [
        request_type,
        requested_by_user_id,
        target_user_id ?? null,
        effectiveManagerId,
        effectiveManagerId, // inbox = manager
        shift_assignment_id ?? null,
        effectiveDivisionId,
        requested_shift_date,
        requested_shift_type_id,
        requested_department_id,
        decision_comment ?? null,
      ];

      const result = await client.query(insertQuery, insertValues);
      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    }

    // ---- SWITCH ----
    if (typeUpper === 'SWITCH') {
      if (!source_shift_assignment_id || !target_shift_assignment_id || !target_user_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'SWITCH requires source_shift_assignment_id, target_shift_assignment_id and target_user_id.',
        });
      }

      const srcRes = await client.query(
        `SELECT * FROM shiftly_schema.shift_assignments WHERE id = $1 FOR UPDATE`,
        [source_shift_assignment_id]
      );
      const tgtRes = await client.query(
        `SELECT * FROM shiftly_schema.shift_assignments WHERE id = $1 FOR UPDATE`,
        [target_shift_assignment_id]
      );
      if (!srcRes.rows.length || !tgtRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Source or target assignment not found.' });
      }
      const src = srcRes.rows[0];
      const tgt = tgtRes.rows[0];

      if (Number(src.user_id) !== Number(requested_by_user_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'source_shift_assignment_id must belong to requested_by_user_id.' });
      }
      if (Number(tgt.user_id) !== Number(target_user_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'target_shift_assignment_id must belong to target_user_id.' });
      }
      if (src.is_absence === true || tgt.is_absence === true) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Absence assignments cannot be switched.' });
      }

      // Must be same month
      const monthSrc = String(src.shift_date).slice(0, 7);
      const monthTgt = String(tgt.shift_date).slice(0, 7);
      if (monthSrc !== monthTgt) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Switch is only allowed within the same month.' });
      }

      // Must be same combination: division, department, staff_type, shift_type
      const sameCombo =
        Number(src.division_id ?? 0) === Number(tgt.division_id ?? 0) &&
        Number(src.department_id) === Number(tgt.department_id) &&
        Number(src.staff_type_id) === Number(tgt.staff_type_id) &&
        Number(src.shift_type_id) === Number(tgt.shift_type_id);
      if (!sameCombo) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Switch is only allowed for same division/department/staff_type/shift_type.',
        });
      }

      // Overlap checks:
      // - target user taking src shift (on src date)
      // - source user taking tgt shift (on tgt date)
      const excludeForTarget = (String(tgt.shift_date) === String(src.shift_date)) ? tgt.id : null;
      const excludeForSource = (String(src.shift_date) === String(tgt.shift_date)) ? src.id : null;

      const targetHasOverlap = await userHasOverlappingAssignment(client, {
        userId: Number(target_user_id),
        shiftDate: src.shift_date,
        shiftTypeId: src.shift_type_id,
        excludeAssignmentId: excludeForTarget,
      });
      if (targetHasOverlap) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Target user has an overlapping shift at the source shift date/time.' });
      }

      const sourceHasOverlap = await userHasOverlappingAssignment(client, {
        userId: Number(requested_by_user_id),
        shiftDate: tgt.shift_date,
        shiftTypeId: tgt.shift_type_id,
        excludeAssignmentId: excludeForSource,
      });
      if (sourceHasOverlap) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Source user has an overlapping shift at the target shift date/time.' });
      }

      const insertQuery = `
        INSERT INTO shiftly_schema.shift_requests (
          request_type,
          request_status,
          requested_by_user_id,
          target_user_id,
          manager_user_id,
          inbox_user_id,
          shift_assignment_id,
          source_shift_assignment_id,
          target_shift_assignment_id,
          division_id,
          requested_shift_date,
          requested_shift_type_id,
          requested_department_id,
          created_at,
          decided_at,
          decision_by_user_id,
          decision_comment
        )
        VALUES (
          'SWITCH',
          'PENDING_TARGET_USER',
          $1,
          $2,
          NULL,
          $2, -- inbox = target user first
          $3, -- keep legacy linkage for display/filter
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          NOW(),
          NULL,
          NULL,
          $9
        )
        RETURNING
          id, request_type, request_status, requested_by_user_id, target_user_id,
          manager_user_id, inbox_user_id, shift_assignment_id, division_id,
          requested_shift_date, requested_shift_type_id, requested_department_id,
          created_at, decided_at, decision_by_user_id, decision_comment,
          source_shift_assignment_id, target_shift_assignment_id, shift_offer_id,
          last_action_at, last_action_by_user_id
      `;

      const result = await client.query(insertQuery, [
        requested_by_user_id,
        target_user_id,
        src.id,
        tgt.id,
        src.division_id ?? null,
        src.shift_date,
        src.shift_type_id,
        src.department_id,
        decision_comment ?? null,
      ]);

      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    }

    // ---- OFFER (take an offered shift) ----
    if (typeUpper === 'OFFER') {
      // Either pass shift_offer_id, OR pass shift_assignment_id and we locate its ACTIVE offer.
      let offerId = shift_offer_id ?? null;
      if (!offerId) {
        if (!shift_assignment_id) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'OFFER requires shift_offer_id or shift_assignment_id.' });
        }
        const o = await client.query(
          `SELECT id FROM shiftly_schema.shift_offers WHERE shift_assignment_id = $1 AND status = 'ACTIVE' LIMIT 1`,
          [shift_assignment_id]
        );
        if (!o.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'No ACTIVE offer found for that assignment.' });
        }
        offerId = o.rows[0].id;
      }

      const offerRes = await client.query(
        `
        SELECT so.*, sa.*
          FROM shiftly_schema.shift_offers so
          JOIN shiftly_schema.shift_assignments sa ON sa.id = so.shift_assignment_id
         WHERE so.id = $1
         FOR UPDATE
        `,
        [offerId]
      );
      if (!offerRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Offer not found.' });
      }
      const row = offerRes.rows[0];

      if (row.status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Offer is not ACTIVE (current=${row.status}).` });
      }
      if (row.is_absence === true) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Absence assignments cannot be taken.' });
      }
      if (Number(row.offered_by_user_id) === Number(requested_by_user_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You cannot take your own offered shift.' });
      }

      // Overlap check for requestor
      const overlap = await userHasOverlappingAssignment(client, {
        userId: Number(requested_by_user_id),
        shiftDate: row.shift_date,
        shiftTypeId: row.shift_type_id,
      });
      if (overlap) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Requesting user has an overlapping shift on that date/time.' });
      }

      // Inbox goes to offering user's manager first (remove shift from them)
      const ownerManagerId = await getPrimaryManagerId(client, row.offered_by_user_id);

      const insertQuery = `
        INSERT INTO shiftly_schema.shift_requests (
          request_type,
          request_status,
          requested_by_user_id,
          target_user_id,
          manager_user_id,
          inbox_user_id,
          shift_assignment_id,
          source_shift_assignment_id,
          shift_offer_id,
          division_id,
          requested_shift_date,
          requested_shift_type_id,
          requested_department_id,
          created_at,
          decided_at,
          decision_by_user_id,
          decision_comment
        )
        VALUES (
          'OFFER',
          'PENDING_OFFER_OWNER_MANAGER',
          $1,
          $2,
          $3,
          $3,
          $4,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          NOW(),
          NULL,
          NULL,
          $10
        )
        RETURNING
          id, request_type, request_status, requested_by_user_id, target_user_id,
          manager_user_id, inbox_user_id, shift_assignment_id, division_id,
          requested_shift_date, requested_shift_type_id, requested_department_id,
          created_at, decided_at, decision_by_user_id, decision_comment,
          source_shift_assignment_id, target_shift_assignment_id, shift_offer_id,
          last_action_at, last_action_by_user_id
      `;

      const result = await client.query(insertQuery, [
        requested_by_user_id,
        row.offered_by_user_id, // target_user = offering user
        ownerManagerId,         // manager/inbox
        row.shift_assignment_id,
        offerId,
        row.division_id ?? null,
        row.shift_date,
        row.shift_type_id,
        row.department_id,
        decision_comment ?? null,
      ]);

      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    }

    await client.query('ROLLBACK');
    return res.status(400).json({ error: `Unsupported request_type: ${request_type}` });
  } catch (err) {

    if (client) {
  try { await client.query('ROLLBACK'); } catch (_) {}
}
    console.error('Error inserting into DB (SHIFT REQUESTS CREATE):', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
if (client) client.release();
  }
});

/**
 * POST /shift-requests/:id/approve
 *
 * Body:
 *  - decision_by_user_id (required, manager user id)
 *  - decision_comment (optional)
 */
router.post('/:id/approve', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { decision_by_user_id, decision_comment } = req.body;

    if (!decision_by_user_id) {
      return res.status(400).json({
        error: 'decision_by_user_id is required to approve a request.',
      });
    }

       client = await pool.connect();
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT * FROM shiftly_schema.shift_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const r = reqRes.rows[0];

    const inboxUserId = r.inbox_user_id ?? r.manager_user_id ?? null;
    if (inboxUserId != null && Number(inboxUserId) !== Number(decision_by_user_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not the current approver for this request.' });
    }

    const type = String(r.request_type).toUpperCase();
    const status = String(r.request_status).toUpperCase();

    // NEW_SHIFT: single-step approve (legacy)
    if (type === 'NEW_SHIFT') {
      const upd = await client.query(
        `
        UPDATE shiftly_schema.shift_requests
           SET request_status      = 'APPROVED',
               inbox_user_id       = NULL,
               decided_at          = NOW(),
               decision_by_user_id = $1,
               decision_comment    = $2,
               last_action_at      = NOW(),
               last_action_by_user_id = $1
         WHERE id = $3
         RETURNING *
        `,
        [decision_by_user_id, decision_comment ?? null, id]
      );
      await client.query('COMMIT');
      return res.json(upd.rows[0]);
    }

    // SWITCH: multi-step
    if (type === 'SWITCH') {
      if (status === 'PENDING_TARGET_USER') {
        // next: target manager
        const targetManagerId = await getPrimaryManagerId(client, r.target_user_id);
        const upd = await client.query(
          `
          UPDATE shiftly_schema.shift_requests
             SET request_status = 'PENDING_TARGET_MANAGER',
                 inbox_user_id  = $1,
                 last_action_at = NOW(),
                 last_action_by_user_id = $2,
                 decision_comment = COALESCE($3, decision_comment)
           WHERE id = $4
           RETURNING *
          `,
          [targetManagerId, decision_by_user_id, decision_comment ?? null, id]
        );
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      }

      if (status === 'PENDING_TARGET_MANAGER') {
        // next: source manager
        const sourceManagerId = await getPrimaryManagerId(client, r.requested_by_user_id);
        const upd = await client.query(
          `
          UPDATE shiftly_schema.shift_requests
             SET request_status = 'PENDING_SOURCE_MANAGER',
                 inbox_user_id  = $1,
                 last_action_at = NOW(),
                 last_action_by_user_id = $2,
                 decision_comment = COALESCE($3, decision_comment)
           WHERE id = $4
           RETURNING *
          `,
          [sourceManagerId, decision_by_user_id, decision_comment ?? null, id]
        );
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      }

      if (status === 'PENDING_SOURCE_MANAGER') {
        // final: execute swap
        const srcId = r.source_shift_assignment_id ?? r.shift_assignment_id;
        const tgtId = r.target_shift_assignment_id;
        if (!srcId || !tgtId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Missing source/target assignment references for SWITCH.' });
        }

        const srcRes = await client.query(
          `SELECT * FROM shiftly_schema.shift_assignments WHERE id = $1 FOR UPDATE`,
          [srcId]
        );
        const tgtRes = await client.query(
          `SELECT * FROM shiftly_schema.shift_assignments WHERE id = $1 FOR UPDATE`,
          [tgtId]
        );
        if (!srcRes.rows.length || !tgtRes.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Source or target assignment not found.' });
        }
        const src = srcRes.rows[0];
        const tgt = tgtRes.rows[0];

        // Re-validate overlap at approval time
        const excludeForTarget = (String(tgt.shift_date) === String(src.shift_date)) ? tgt.id : null;
        const excludeForSource = (String(src.shift_date) === String(tgt.shift_date)) ? src.id : null;

        const targetHasOverlap = await userHasOverlappingAssignment(client, {
          userId: Number(r.target_user_id),
          shiftDate: src.shift_date,
          shiftTypeId: src.shift_type_id,
          excludeAssignmentId: excludeForTarget,
        });
        if (targetHasOverlap) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Target user has an overlapping shift at the source shift date/time.' });
        }

        const sourceHasOverlap = await userHasOverlappingAssignment(client, {
          userId: Number(r.requested_by_user_id),
          shiftDate: tgt.shift_date,
          shiftTypeId: tgt.shift_type_id,
          excludeAssignmentId: excludeForSource,
        });
        if (sourceHasOverlap) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Source user has an overlapping shift at the target shift date/time.' });
        }

        const srcUser = src.user_id;
        const tgtUser = tgt.user_id;

        // Swap users
        await client.query(
          `UPDATE shiftly_schema.shift_assignments SET user_id = $1, updated_at = NOW() WHERE id = $2`,
          [tgtUser, src.id]
        );
        await client.query(
          `UPDATE shiftly_schema.shift_assignments SET user_id = $1, updated_at = NOW() WHERE id = $2`,
          [srcUser, tgt.id]
        );

        // History
        await client.query(
          `
          INSERT INTO shiftly_schema.shift_assignment_user_history
            (shift_assignment_id, from_user_id, to_user_id, change_reason, shift_request_id, comment)
          VALUES
            ($1, $2, $3, 'SWITCH', $4, $5),
            ($6, $7, $8, 'SWITCH', $4, $5)
          `,
          [
            src.id, srcUser, tgtUser, r.id, decision_comment ?? null,
            tgt.id, tgtUser, srcUser,
          ]
        );

        const upd = await client.query(
          `
          UPDATE shiftly_schema.shift_requests
             SET request_status      = 'APPROVED',
                 inbox_user_id       = NULL,
                 decided_at          = NOW(),
                 decision_by_user_id = $1,
                 decision_comment    = $2,
                 last_action_at      = NOW(),
                 last_action_by_user_id = $1
           WHERE id = $3
           RETURNING *
          `,
          [decision_by_user_id, decision_comment ?? null, id]
        );

        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      }

      await client.query('ROLLBACK');
      return res.status(400).json({ error: `SWITCH cannot be approved from status ${r.request_status}.` });
    }

    // OFFER: manager chain, then transfer assignment to requestor
    if (type === 'OFFER') {
      const offerId = r.shift_offer_id;
      const assignmentId = r.source_shift_assignment_id ?? r.shift_assignment_id;
      if (!offerId || !assignmentId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Missing offer/assignment references for OFFER.' });
      }

      const finalizeTransfer = async () => {
        // lock offer + assignment
        const o = await client.query(
          `
          SELECT so.*, sa.*
            FROM shiftly_schema.shift_offers so
            JOIN shiftly_schema.shift_assignments sa ON sa.id = so.shift_assignment_id
           WHERE so.id = $1
           FOR UPDATE
          `,
          [offerId]
        );
        if (!o.rows.length) {
          throw new Error('Offer not found.');
        }
        const row = o.rows[0];
        if (row.status !== 'ACTIVE') {
          throw new Error(`Offer is not ACTIVE (current=${row.status}).`);
        }

        // overlap re-check
        const overlap = await userHasOverlappingAssignment(client, {
          userId: Number(r.requested_by_user_id),
          shiftDate: row.shift_date,
          shiftTypeId: row.shift_type_id,
        });
        if (overlap) {
          throw new Error('Requesting user has an overlapping shift on that date/time.');
        }

        const fromUser = row.offered_by_user_id;
        const toUser = r.requested_by_user_id;

        await client.query(
          `UPDATE shiftly_schema.shift_assignments SET user_id = $1, status = 'APPROVED', updated_at = NOW() WHERE id = $2`,
          [toUser, row.shift_assignment_id]
        );
        await client.query(
          `
          UPDATE shiftly_schema.shift_offers
             SET status = 'TAKEN',
                 taken_by_user_id = $1,
                 taken_at = NOW()
           WHERE id = $2
          `,
          [toUser, offerId]
        );
        await client.query(
          `
          INSERT INTO shiftly_schema.shift_assignment_user_history
            (shift_assignment_id, from_user_id, to_user_id, change_reason, shift_request_id, shift_offer_id, comment)
          VALUES
            ($1, $2, $3, 'OFFER', $4, $5, $6)
          `,
          [row.shift_assignment_id, fromUser, toUser, r.id, offerId, decision_comment ?? null]
        );
      };

      if (status === 'PENDING_OFFER_OWNER_MANAGER') {
        // If requestor manager differs, route there; else finalize directly
        const requestorManagerId = await getPrimaryManagerId(client, r.requested_by_user_id);
        if (requestorManagerId != null && Number(requestorManagerId) !== Number(decision_by_user_id)) {
          const upd = await client.query(
            `
            UPDATE shiftly_schema.shift_requests
               SET request_status = 'PENDING_REQUESTOR_MANAGER',
                   inbox_user_id  = $1,
                   last_action_at = NOW(),
                   last_action_by_user_id = $2,
                   decision_comment = COALESCE($3, decision_comment)
             WHERE id = $4
             RETURNING *
            `,
            [requestorManagerId, decision_by_user_id, decision_comment ?? null, id]
          );
          await client.query('COMMIT');
          return res.json(upd.rows[0]);
        }

        // Same manager -> finalize
        try {
          await finalizeTransfer();
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: String(e.message || e) });
        }

        const upd = await client.query(
          `
          UPDATE shiftly_schema.shift_requests
             SET request_status      = 'APPROVED',
                 inbox_user_id       = NULL,
                 decided_at          = NOW(),
                 decision_by_user_id = $1,
                 decision_comment    = $2,
                 last_action_at      = NOW(),
                 last_action_by_user_id = $1
           WHERE id = $3
           RETURNING *
          `,
          [decision_by_user_id, decision_comment ?? null, id]
        );
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      }

      if (status === 'PENDING_REQUESTOR_MANAGER') {
        try {
          await finalizeTransfer();
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: String(e.message || e) });
        }

        const upd = await client.query(
          `
          UPDATE shiftly_schema.shift_requests
             SET request_status      = 'APPROVED',
                 inbox_user_id       = NULL,
                 decided_at          = NOW(),
                 decision_by_user_id = $1,
                 decision_comment    = $2,
                 last_action_at      = NOW(),
                 last_action_by_user_id = $1
           WHERE id = $3
           RETURNING *
          `,
          [decision_by_user_id, decision_comment ?? null, id]
        );
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      }

      await client.query('ROLLBACK');
      return res.status(400).json({ error: `OFFER cannot be approved from status ${r.request_status}.` });
    }

    await client.query('ROLLBACK');
    return res.status(400).json({ error: `Unsupported request_type for approve: ${r.request_type}` });
 
  } catch (err) {
     if (client) {
     try { await client.query('ROLLBACK'); } catch (_) {}
   }
    console.error('Error approving shift request:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
if (client) client.release();
  }
});






/**
 * POST /shift-requests/:id/attach-assignment
 *
 * Body:
 *  - shift_assignment_id (required)
 *
 * Used after a NEW_SHIFT request is approved and the client creates the concrete
 * shift_assignment. This endpoint links the request to the created assignment.
 */
router.post('/:id/attach-assignment', async (req, res) => {
  try {
    const { id } = req.params;
    const { shift_assignment_id } = req.body;

    if (shift_assignment_id == null) {
      return res.status(400).json({
        error: 'shift_assignment_id is required',
      });
    }

 // Only makes sense for NEW_SHIFT requests
    const query = `
      UPDATE shiftly_schema.shift_requests
      SET shift_assignment_id = $1
      WHERE id = $2
       AND request_type = 'NEW_SHIFT'
      RETURNING
        id,
        request_type,
        request_status,
        requested_by_user_id,
        target_user_id,
        manager_user_id,
        inbox_user_id,
        shift_assignment_id,
        division_id,
        requested_shift_date,
        requested_shift_type_id,
        requested_department_id,
        created_at,
        decided_at,
        decision_by_user_id,
        decision_comment,
        source_shift_assignment_id,
        target_shift_assignment_id,
        shift_offer_id,
        last_action_at,
        last_action_by_user_id
    `;

    const values = [shift_assignment_id, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error attaching assignment to shift request:', err);
    res.status(500).json({ error: 'Database error' });
  }
});




/**
 * POST /shift-requests/:id/reject
 *
 * Body:
 *  - decision_by_user_id (required, manager user id)
 *  - decision_comment (optional)
 */
router.post('/:id/reject', async (req, res) => {
 let client;
  try {
    const { id } = req.params;
    const { decision_by_user_id, decision_comment } = req.body;

    if (!decision_by_user_id) {
      return res.status(400).json({
        error: 'decision_by_user_id is required to reject a request.',
      });
    }

     client = await pool.connect();
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT * FROM shiftly_schema.shift_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const r = reqRes.rows[0];

    const inboxUserId = r.inbox_user_id ?? r.manager_user_id ?? null;
    if (inboxUserId != null && Number(inboxUserId) !== Number(decision_by_user_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not the current approver for this request.' });
    }

    const upd = await client.query(
      `
      UPDATE shiftly_schema.shift_requests
         SET request_status      = 'REJECTED',
             inbox_user_id       = NULL,
             decided_at          = NOW(),
             decision_by_user_id = $1,
             decision_comment    = $2,
             last_action_at      = NOW(),
             last_action_by_user_id = $1
       WHERE id = $3
       RETURNING *
      `,
      [decision_by_user_id, decision_comment ?? null, id]
    );

    await client.query('COMMIT');
    res.json(upd.rows[0]);
  } catch (err) {
        if (client) {
     try { await client.query('ROLLBACK'); } catch (_) {}
   }
    console.error('Error rejecting shift request:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
if (client) client.release();
  }
});

module.exports = router;


