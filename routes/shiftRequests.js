// shiftRequests.js
const express = require('express');
const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');
const {
  runInTransactionWithBusinessTimezone,
} = require('../utils/shiftlyRuntimeConfig');

const router = express.Router();


function normalizeShiftRequestRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    requested_shift_date:
      row.requested_shift_date == null
        ? row.requested_shift_date
        : String(row.requested_shift_date).slice(0, 10),
  };
}

function decorateShiftRequestWorkflowOutcome(row) {
  const normalized = normalizeShiftRequestRow(row);
  if (!normalized || typeof normalized !== 'object') return normalized;

  const status = String(normalized.request_status || '').toUpperCase();
  const comment = String(normalized.decision_comment || '').trim();

  if (status === 'REJECTED' && /^\[SYSTEM\]/i.test(comment)) {
    return {
      ...normalized,
      workflow_action: 'AUTO_REJECTED',
      workflow_message: comment.replace(/^\[SYSTEM\]\s*/i, '').trim(),
    };
  }

  return normalized;
}

function normalizeShiftRequestRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(normalizeShiftRequestRow);
}

// Small helper: normalize client input for absence types
function normalizeAbsenceType(code) {
  const v = String(code ?? '').trim();
  return v ? v.toUpperCase() : '';
}

function asIntOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function setWorkflowScopeForCreate(client, body) {
  const requestType = String(body?.request_type || '').trim().toUpperCase();
  let divisionId = null;
  let departmentId = null;

  if (requestType === 'NEW_SHIFT') {
    divisionId = asIntOrNull(body?.division_id ?? body?.divisionId);
    departmentId = asIntOrNull(
      body?.requested_department_id ?? body?.requestedDepartmentId,
    );
  } else if (requestType === 'OFF_REQUEST') {
    const assignmentId = asIntOrNull(
      body?.shift_assignment_id ?? body?.shiftAssignmentId,
    );
    if (assignmentId != null) {
      const result = await client.query(
        `
        SELECT division_id, department_id
        FROM shiftly_schema.shift_assignments
        WHERE id = $1
        LIMIT 1
        `,
        [assignmentId],
      );
      divisionId = result.rows?.[0]?.division_id ?? null;
      departmentId = result.rows?.[0]?.department_id ?? null;
    }
  } else if (requestType === 'OFFER') {
    const offerId = asIntOrNull(body?.shift_offer_id ?? body?.shiftOfferId);
    const assignmentId = asIntOrNull(
      body?.shift_assignment_id ?? body?.shiftAssignmentId,
    );
    const result = await client.query(
      `
      SELECT sa.division_id, sa.department_id
      FROM shiftly_schema.shift_assignments sa
      LEFT JOIN shiftly_schema.shift_offers so
        ON so.shift_assignment_id = sa.id
      WHERE ($1::int IS NOT NULL AND so.id = $1::int)
         OR ($2::int IS NOT NULL AND sa.id = $2::int)
      ORDER BY sa.id
      LIMIT 1
      `,
      [offerId, assignmentId],
    );
    divisionId = result.rows?.[0]?.division_id ?? null;
    departmentId = result.rows?.[0]?.department_id ?? null;
  }

  if (divisionId != null && departmentId != null) {
    await client.query(
      `SELECT set_config('shiftly.request_division_id', $1, true),
              set_config('shiftly.request_department_id', $2, true)`,
      [String(divisionId), String(departmentId)],
    );
  }
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
      return sendApiError(req, res, {
        status: 400,
        error: 'Choose a workflow inbox or requester before loading requests.',
        code: 'INVALID_REQUEST',
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
        return sendApiError(req, res, {
          status: 400,
          error: 'The inbox user is invalid.',
          code: 'INVALID_REQUEST',
        });
      }
      values.push(actorId);
      const index = values.length;
      whereClauses.push(`sr.inbox_user_id = $${index}`);
    } else if (managerUserId) {
      // ✅ Legacy support only (for old NEW_SHIFT rows that may have inbox_user_id NULL)
      // IMPORTANT: Do NOT leak SWITCH/OFFER/etc to manager unless inbox_user_id == manager.
      const actorId = parseInt(String(managerUserId), 10);
	      if (Number.isNaN(actorId)) {
       return sendApiError(req, res, {
         status: 400,
         error: 'The manager user is invalid.',
         code: 'INVALID_REQUEST',
       });
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
                   AND um.is_active = TRUE
                   AND um.division_id = sr.division_id
                   AND um.department_id = sr.requested_department_id
              )
            )
          )
        )
      `);
    }
	
	
    // ✅ extra hard safety: never allow returning everything
    if (whereClauses.length === 0) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Choose a workflow inbox or requester before loading requests.',
        code: 'INVALID_REQUEST',
      });
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Read the workflow projection and resolve actor labels directly from
    // shiftly_schema.users.
    //
    // Do not depend only on the Flutter active-user lookup here:
    // historical/pending requests may reference an inactive user, and the
    // client lookup cache may not yet contain a newly created user.
    const query = `
      SELECT
        sr.*,
        to_char(
          sr.requested_shift_date,
          'YYYY-MM-DD'
        ) AS requested_shift_date,
        requested_by_user.user_name AS requested_by_user_name,
        requested_by_user.user_desc AS requested_by_user_desc,
        target_user.user_name AS target_user_name,
        target_user.user_desc AS target_user_desc
      FROM shiftly_api.v_shift_requests sr
      LEFT JOIN shiftly_schema.users requested_by_user
        ON requested_by_user.id = sr.requested_by_user_id
      LEFT JOIN shiftly_schema.users target_user
        ON target_user.id = sr.target_user_id
      ${whereSql}
      ORDER BY sr.created_at DESC
    `;

    const result = await pool.query(query, values);
    res.json(normalizeShiftRequestRows(result.rows));
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error querying DB (SHIFT REQUESTS LIST)',
    });
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
      return sendApiError(req, res, {
        status: 400,
        error: 'The request id is invalid.',
        code: 'INVALID_REQUEST',
      });
    }

    const actorRaw =
      req.query?.actorUserId ??
      req.query?.actor_user_id ??
      req.body?.actor_user_id ??
      req.body?.actorUserId ??
      null;

    const actorUserId = parseInt(String(actorRaw ?? ''), 10);
    if (Number.isNaN(actorUserId)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'The acting user is required.',
        code: 'INVALID_REQUEST',
      });
    }

    // Call stored function (single statement; DB handles locking/validation)
    const result = await pool.query(
      `SELECT shiftly_api.shift_request_retract($1::int, $2::int) AS payload`,
      [requestId, actorUserId]
    );
    return res.json(result.rows[0].payload);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'DELETE',
      label: 'Error retracting shift request',
    });
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

        // Normalize absence type fields (client may send lowercase)
    if (req?.body?.requested_absence_type != null) {
      req.body.requested_absence_type = normalizeAbsenceType(
        req.body.requested_absence_type
      );
    }
    if (req?.body?.absence_type != null) {
      req.body.absence_type = normalizeAbsenceType(req.body.absence_type);
    }

    const requestBody = { ...(req.body ?? {}) };
    delete requestBody.manager_user_id;
    delete requestBody.managerUserId;

    const result = await runInTransactionWithBusinessTimezone(
      pool,
      async (client) => {
        await setWorkflowScopeForCreate(client, requestBody);
        return client.query(
          `SELECT * FROM shiftly_api.shift_request_create($1::jsonb)`,
          [JSON.stringify(requestBody)],
        );
      },
    );
    return res.status(201).json(normalizeShiftRequestRow(result.rows[0]));
  } catch (err) {

    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error inserting into DB (SHIFT REQUESTS CREATE)',
    });
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
      return sendApiError(req, res, {
        status: 400,
        error: 'The request id is invalid.',
        code: 'INVALID_REQUEST',
      });
    }

    const { decision_by_user_id, decision_comment } = req.body ?? {};
    if (!decision_by_user_id) {
      return sendApiError(req, res, {
        status: 400,
        error: 'The decision user is required to approve a request.',
        code: 'INVALID_REQUEST',
      });
    }

    const result = await runInTransactionWithBusinessTimezone(
      pool,
      async (client) => {
        await client.query(
          `SELECT set_config('shiftly.workflow_request_id', $1, true)`,
          [String(rid)],
        );
        return client.query(
          `SELECT * FROM shiftly_api.shift_request_approve($1::int, $2::int, $3::text)`,
          [rid, decision_by_user_id, decision_comment ?? null],
        );
      },
    );
     return res.json(decorateShiftRequestWorkflowOutcome(result.rows[0]));
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'APPROVE',
      label: 'Error approving shift request',
    });
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
      return sendApiError(req, res, {
        status: 400,
        error: 'A shift assignment is required.',
        code: 'INVALID_REQUEST',
      });
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
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested record could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }
    const r = reqRes.rows[0];

    // Optional safety: attach only after approval (prevents history for unapproved requests)
    if (String(r.request_status).toUpperCase() !== 'APPROVED') {
      await client.query('ROLLBACK');
      return sendApiError(req, res, {
        status: 422,
        error: 'The assignment can only be attached after the request is approved.',
        code: 'INVALID_OPERATION',
      });
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
      return sendApiError(req, res, {
        status: 404,
        error: 'The shift assignment could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
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
         to_char(requested_shift_date, 'YYYY-MM-DD') AS requested_shift_date,
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
     return res.json(normalizeShiftRequestRow(updRes.rows[0]));
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error attaching assignment to shift request',
    });
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
      return sendApiError(req, res, {
        status: 400,
        error: 'The request id is invalid.',
        code: 'INVALID_REQUEST',
      });
    }

    const { decision_by_user_id, decision_comment } = req.body ?? {};
    if (!decision_by_user_id) {
      return sendApiError(req, res, {
        status: 400,
        error: 'The decision user is required to reject a request.',
        code: 'INVALID_REQUEST',
      });
    }

    const result = await pool.query(
      `SELECT * FROM shiftly_api.shift_request_reject($1::int, $2::int, $3::text)`,
      [rid, decision_by_user_id, decision_comment ?? null]
    );
    return res.json(normalizeShiftRequestRow(result.rows[0]));
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'REJECT',
      label: 'Error rejecting shift request',
    });
  }
});

module.exports = router;


