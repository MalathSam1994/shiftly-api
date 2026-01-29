// shiftRequests.js
const express = require('express');
const pool = require('../db');

const router = express.Router();

 function pgErrorToHttpStatus(err) {
   const code = String(err?.code ?? '');
   if (code === 'P0002') return 404;   // no_data_found (custom raise)
   if (code === '28000') return 403;   // invalid authorization specification
 
   // Treat common SQLSTATE classes as client errors (validation/business rules)
   // 22xxx = data exception (includes 22023 invalid_parameter_value)
   // 23xxx = integrity constraint violation
   if (/^(22|23)/.test(code)) return 400;
 
   // You can extend here if you use specific custom SQLSTATEs.
   return 500;
 }
 
 function sendDbError(res, err, context, httpStatus = 500) {
  // Return rich PG error details so the Flutter client shows the REAL reason
  // (your ShiftRequestRepository already parses: message/detail/code/constraint/table/column).
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
 return res.status(httpStatus).json(payload);
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
 
     // ✅ Safety: never allow "list everything" by mistake
    const hasAnyFilter =
      (inboxUserId != null && String(inboxUserId).trim() !== '') ||
      (managerUserId != null && String(managerUserId).trim() !== '') ||
      (requestedByUserId != null && String(requestedByUserId).trim() !== '');

    if (!hasAnyFilter) {
      return res.status(400).json({
        error: 'At least one of inboxUserId, managerUserId, requestedByUserId is required.',
      });
    }

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
  whereClauses.push(`sr.division_id = $${index}`);
    }



     const hasInboxParam =
       inboxUserId != null && String(inboxUserId).trim() !== '';

    if (hasInboxParam) {
      // ✅ STRICT INBOX MODE:
      // Only show items where THIS user is the current approver.
      const actorId = parseInt(String(inboxUserId), 10);
	      if (Number.isNaN(actorId)) {
        return res.status(400).json({ error: 'Invalid inboxUserId' });
      }
      values.push(actorId);
      const index = values.length;
      whereClauses.push(`sr.inbox_user_id = $${index}`);
    } else if (managerUserId) {
      // ✅ Legacy support only (for old NEW_SHIFT rows that may have inbox_user_id NULL)
      // IMPORTANT: Do NOT leak SWITCH/OFFER/etc to manager unless inbox_user_id == manager.
      const actorId = parseInt(String(managerUserId), 10);
	      if (Number.isNaN(actorId)) {
       return res.status(400).json({ error: 'Invalid managerUserId' });
     }
      values.push(actorId);
      const index = values.length;

      whereClauses.push(`
        (
          -- normal: manager sees only items currently in their inbox
          sr.inbox_user_id = $${index}

          OR

          -- legacy: old NEW_SHIFT rows without inbox_user_id (backward compatibility only)
          (
            sr.inbox_user_id IS NULL
            AND sr.request_type = 'NEW_SHIFT'
            AND (
              sr.manager_user_id = $${index}
              OR EXISTS (
                SELECT 1
                  FROM shiftly_schema.user_managers um
                 WHERE um.user_id = sr.requested_by_user_id
                   AND um.manager_user_id = $${index}
                   AND um.is_primary = TRUE
              )
            )
          )
        )
      `);
    }
	
	
    // ✅ extra hard safety: never allow returning everything
    if (whereClauses.length === 0) {
      return res.status(400).json({
        error: 'No valid filters applied (would return everything).',
      });
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

       // Read from VIEW (centralized projection)
   const query = `
     SELECT *
       FROM shiftly_api.v_shift_requests sr
     ${whereSql}
     ORDER BY created_at DESC
   `;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error('Error querying DB (SHIFT REQUESTS LIST):', err);
     return sendDbError(res, err, 'SHIFT REQUESTS LIST', pgErrorToHttpStatus(err));
  }
});

/**
 * DELETE /shift-requests/:id
 *
 * Retract (delete) a request while it's still pending, regardless of type:
 *   NEW_SHIFT | OFF_REQUEST | SWITCH | OFFER
 *
 * Permission:
 *  - only the request creator (requested_by_user_id) may retract
 *
 * Allowed statuses:
 *  - any status that starts with "PENDING" (PENDING, PENDING_TARGET_USER, PENDING_TARGET_MANAGER, ...)
 *
 * Accepts actor user id via:
 *  - query:  actorUserId / actor_user_id
 *  - body:   actor_user_id / actorUserId
 */
router.delete('/:id', async (req, res) => {
 
   try {
    const { id } = req.params;
    const requestId = parseInt(String(id), 10);
    if (Number.isNaN(requestId)) {
      return res.status(400).json({ error: 'Invalid request id' });
    }

    const actorRaw =
      req.query?.actorUserId ??
      req.query?.actor_user_id ??
      req.body?.actor_user_id ??
      req.body?.actorUserId ??
      null;

    const actorUserId = parseInt(String(actorRaw ?? ''), 10);
    if (Number.isNaN(actorUserId)) {
      return res.status(400).json({ error: 'actorUserId is required.' });
    }

    // Call stored function (single statement; DB handles locking/validation)
    const result = await pool.query(
      `SELECT shiftly_api.shift_request_retract($1::int, $2::int) AS payload`,
      [requestId, actorUserId]
    );
    return res.json(result.rows[0].payload);
  } catch (err) {
    console.error('Error retracting shift request:', err);
   const http = pgErrorToHttpStatus(err);
 return sendDbError(res, err, 'RETRACT SHIFT REQUEST', http);
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

  try {
       // One call: DB validates + inserts + returns row
    const result = await pool.query(
      `SELECT * FROM shiftly_api.shift_request_create($1::jsonb)`,
      [JSON.stringify(req.body ?? {})]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {

    console.error('Error inserting into DB (SHIFT REQUESTS CREATE):', err);
      const http = pgErrorToHttpStatus(err);
  return sendDbError(res, err, 'SHIFT REQUESTS CREATE', http);
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

   try {
    const rid = parseInt(String(req.params.id), 10);
    if (Number.isNaN(rid)) {
      return res.status(400).json({ error: 'Invalid request id' });
    }

    const { decision_by_user_id, decision_comment } = req.body ?? {};
    if (!decision_by_user_id) {
      return res.status(400).json({
        error: 'decision_by_user_id is required to approve a request.',
      });
    }

    // Thin wrapper around DB function
    const result = await pool.query(
      `SELECT * FROM shiftly_api.shift_request_approve($1::int, $2::int, $3::text)`,
      [rid, decision_by_user_id, decision_comment ?? null]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error approving shift request:', err);
    const http = pgErrorToHttpStatus(err);
    return sendDbError(res, err, 'APPROVE SHIFT REQUEST', http);
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
  let client;
  try {
    const { id } = req.params;
    const { shift_assignment_id } = req.body;

    if (shift_assignment_id == null) {
      return res.status(400).json({ error: 'shift_assignment_id is required' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Lock request row (must be NEW_SHIFT)
    const reqRes = await client.query(
      `SELECT *
         FROM shiftly_schema.shift_requests
        WHERE id = $1
          AND request_type = 'NEW_SHIFT'
        FOR UPDATE`,
      [id]
    );
    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const r = reqRes.rows[0];

    // Optional safety: attach only after approval (prevents history for unapproved requests)
    if (String(r.request_status).toUpperCase() !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot attach assignment unless request is APPROVED.' });
    }

    // Lock assignment row
    const asgRes = await client.query(
      `SELECT *
         FROM shiftly_schema.shift_assignments
        WHERE id = $1
        FOR UPDATE`,
      [shift_assignment_id]
    );
    if (!asgRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'shift_assignment_id not found' });
    }
    const a = asgRes.rows[0];

    // Link request -> assignment
    const updRes = await client.query(
      `
      UPDATE shiftly_schema.shift_requests
         SET shift_assignment_id = $1,
             last_action_at = NOW(),
             last_action_by_user_id = COALESCE(decision_by_user_id, last_action_by_user_id)
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
      `,
      [shift_assignment_id, id]
    );

    // Insert history record for this NEW_SHIFT assignment (idempotent)
    // from_user_id is NULL (new assignment), to_user_id is assignment.user_id (fallback requested_by_user_id)
    const toUserId = a.user_id ?? r.requested_by_user_id ?? null;

    if (toUserId != null) {
      const exists = await client.query(
        `
        SELECT 1
          FROM shiftly_schema.shift_assignment_user_history h
         WHERE h.shift_assignment_id = $1
           AND h.shift_request_id = $2
           AND h.change_reason = 'NEW_SHIFT'
         LIMIT 1
        `,
        [shift_assignment_id, id]
      );

      if (!exists.rows.length) {
        await client.query(
          `
          INSERT INTO shiftly_schema.shift_assignment_user_history
           (
              shift_assignment_id,
              from_user_id,
              to_user_id,
              change_reason,
              shift_request_id,
              shift_date,
              shift_type_id,
              department_id,
              division_id,
              comment
            )
          VALUES
         ($1, NULL, $2, 'NEW_SHIFT', $3, $4, $5, $6, $7, $8)
          `,
          [
            shift_assignment_id,
            toUserId,
            id,
            a.shift_date,
            a.shift_type_id,
            a.department_id,
            a.division_id ?? null,
            r.decision_comment ?? null,
          ]
        );
      }
    }

    await client.query('COMMIT');
    return res.json(updRes.rows[0]);
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Error attaching assignment to shift request:', err);
    return sendDbError(res, err, 'ATTACH ASSIGNMENT', pgErrorToHttpStatus(err));
  } finally {
    if (client) client.release();
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

    try {
    const rid = parseInt(String(req.params.id), 10);
    if (Number.isNaN(rid)) {
      return res.status(400).json({ error: 'Invalid request id' });
    }

    const { decision_by_user_id, decision_comment } = req.body ?? {};
    if (!decision_by_user_id) {
      return res.status(400).json({
        error: 'decision_by_user_id is required to reject a request.',
      });
    }

    const result = await pool.query(
      `SELECT * FROM shiftly_api.shift_request_reject($1::int, $2::int, $3::text)`,
      [rid, decision_by_user_id, decision_comment ?? null]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error rejecting shift request:', err);
   const http = pgErrorToHttpStatus(err);
    return sendDbError(res, err, 'REJECT SHIFT REQUEST', http);
  }
});

module.exports = router;


