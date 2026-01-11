// shiftRequests.js
const express = require('express');
const pool = require('../db');

const router = express.Router();

function sendDbError(res, err, context) {
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
  return res.status(500).json(payload);
}



async function getPrimaryManagerId(client, userId) {
	if (userId == null) return null;
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
       AND NOT (COALESCE(sa.is_absence::text, 'false') IN ('t','true','1'))
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

function isAbsenceValue(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

async function userHasAbsenceOnDate(client, { userId, shiftDate }) {
  const r = await client.query(
    `
    SELECT 1
      FROM shiftly_schema.user_absences ua
     WHERE ua.user_id = $1
       AND $2::date BETWEEN ua.start_date AND ua.end_date
     LIMIT 1
    `,
    [userId, shiftDate]
  );
  return r.rows.length > 0;
}

/**
 * Remove ONE specific date from user_absences for a user.
 * - If absence is exactly that day -> DELETE row
 * - If range starts that day -> start_date = day+1
 * - If range ends that day   -> end_date   = day-1
 * - If range spans over day  -> SPLIT into two rows (left + right)
 *
 * This is used when an approved NEW_SHIFT / SWITCH / OFFER means:
 * "User is scheduled to work on that date, so absence must not cover it."
 */
async function removeAbsenceCoverageForDate(client, {
  userId,
  shiftDate, // date or string
  actorUserId = null, // (optional) who triggered this change (manager)
  reason = null,      // (optional) for comment enrichment
}) {
  if (userId == null || shiftDate == null) return;

  // Lock all absences that cover this date (we will modify/delete/split).
  const abs = await client.query(
    `
    SELECT id, user_id, absence_type, start_date, end_date, created_by, comment
      FROM shiftly_schema.user_absences
     WHERE user_id = $1
       AND $2::date BETWEEN start_date AND end_date
     ORDER BY updated_at DESC, id DESC
     FOR UPDATE
    `,
    [Number(userId), shiftDate]
  );
  if (!abs.rows.length) return;

  for (const ua of abs.rows) {
    // 1) Exact single-day absence -> delete
    const exact = await client.query(
      `
      SELECT 1
        FROM shiftly_schema.user_absences
       WHERE id = $1
         AND start_date = $2::date
         AND end_date   = $2::date
       LIMIT 1
      `,
      [ua.id, shiftDate]
    );
    if (exact.rows.length) {
      await client.query(`DELETE FROM shiftly_schema.user_absences WHERE id = $1`, [ua.id]);
      continue;
    }

    // 2) Range starts at this day -> move start_date forward by 1 day
    const starts = await client.query(
      `
      SELECT 1
        FROM shiftly_schema.user_absences
       WHERE id = $1
         AND start_date = $2::date
         AND end_date   > $2::date
       LIMIT 1
      `,
      [ua.id, shiftDate]
    );
    if (starts.rows.length) {
      await client.query(
        `
        UPDATE shiftly_schema.user_absences
           SET start_date = ($1::date + INTERVAL '1 day')::date,
               updated_at = NOW(),
               comment    = COALESCE(comment, '') ||
                            CASE WHEN $2::text IS NULL THEN '' ELSE
                              CASE WHEN COALESCE(comment,'') = '' THEN '' ELSE E'\n' END ||
                              '[AUTO] removed date ' || $1::text || ' (' || $2::text || ')'
                            END
         WHERE id = $3
        `,
        [shiftDate, reason, ua.id]
      );
      continue;
    }

    // 3) Range ends at this day -> move end_date backward by 1 day
    const ends = await client.query(
      `
      SELECT 1
        FROM shiftly_schema.user_absences
       WHERE id = $1
         AND end_date   = $2::date
         AND start_date < $2::date
       LIMIT 1
      `,
      [ua.id, shiftDate]
    );
    if (ends.rows.length) {
      await client.query(
        `
        UPDATE shiftly_schema.user_absences
           SET end_date   = ($1::date - INTERVAL '1 day')::date,
               updated_at = NOW(),
               comment    = COALESCE(comment, '') ||
                            CASE WHEN $2::text IS NULL THEN '' ELSE
                              CASE WHEN COALESCE(comment,'') = '' THEN '' ELSE E'\n' END ||
                              '[AUTO] removed date ' || $1::text || ' (' || $2::text || ')'
                            END
         WHERE id = $3
        `,
        [shiftDate, reason, ua.id]
      );
      continue;
    }

    // 4) Date is strictly inside the range -> split into two ranges
    // Left part: keep current row, set end_date = day-1
    // Right part: insert new row, start_date = day+1, end_date = old_end_date
    await client.query(
      `
      UPDATE shiftly_schema.user_absences
         SET end_date   = ($1::date - INTERVAL '1 day')::date,
             updated_at = NOW(),
             comment    = COALESCE(comment, '') ||
                          CASE WHEN $2::text IS NULL THEN '' ELSE
                            CASE WHEN COALESCE(comment,'') = '' THEN '' ELSE E'\n' END ||
                            '[AUTO] split to remove date ' || $1::text || ' (' || $2::text || ')'
                          END
       WHERE id = $3
      `,
      [shiftDate, reason, ua.id]
    );

    await client.query(
      `
      INSERT INTO shiftly_schema.user_absences
        (user_id, absence_type, start_date, end_date, created_by, comment)
      VALUES
        ($1, $2, ($3::date + INTERVAL '1 day')::date, $4::date, $5, $6)
      `,
      [
        ua.user_id,
        ua.absence_type,
        shiftDate,
        ua.end_date,
        ua.created_by ?? actorUserId ?? null,
        ua.comment,
      ]
    );
  }
}



// Normalize any PG date/timestamp value to a stable "YYYY-MM-DD" key.
function ymdKey(v) {
  if (v == null) return null;

  if (v instanceof Date) {
    const y = v.getUTCFullYear().toString().padStart(4, '0');
    const m = (v.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = v.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const s = String(v);
  if (!s) return null;

  const datePart = s.split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;

  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getUTCFullYear().toString().padStart(4, '0');
    const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = dt.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function isSameAssignmentSlot(a, b) {
  // slot = the uq_assignment key WITHOUT user_id
  return (
    Number(a?.shift_period_id) === Number(b?.shift_period_id) &&
    ymdKey(a?.shift_date) === ymdKey(b?.shift_date) &&
    Number(a?.shift_type_id) === Number(b?.shift_type_id) &&
    Number(a?.department_id) === Number(b?.department_id) &&
    Number(a?.division_id ?? 0) === Number(b?.division_id ?? 0)
  );
}

async function resolveUqAssignmentConflict(client, {
  shiftPeriodId,
  shiftDate,
  userId,
  shiftTypeId,
  departmentId,
  divisionId,
  excludeAssignmentId = null,
}) {
  // If the target user already has an assignment with the exact uq_assignment key,
  // we will:
  //  - HARD FAIL if it's active / absence
  //  - AUTO-DELETE if it's CANCELLED (because uq_assignment currently blocks reuse)
  const r = await client.query(
    `
    SELECT id, status, is_absence
      FROM shiftly_schema.shift_assignments
     WHERE shift_period_id = $1
       AND shift_date      = $2
       AND user_id         = $3
       AND shift_type_id   = $4
       AND department_id   = $5
       AND division_id     = $6
       AND ($7::int IS NULL OR id <> $7)
     LIMIT 1
    `,
    [shiftPeriodId, shiftDate, userId, shiftTypeId, departmentId, divisionId, excludeAssignmentId]
  );
  if (!r.rows.length) return;

  const row = r.rows[0];
  if (isAbsenceValue(row.is_absence)) {
    const e = new Error(`User already has an ABSENCE entry for this shift slot (assignmentId=${row.id}).`);
    e.httpStatus = 400;
    throw e;
  }

  if (String(row.status).toUpperCase() === 'CANCELLED') {
    await client.query(`DELETE FROM shiftly_schema.shift_assignments WHERE id = $1`, [row.id]);
    return;
  }

  const e = new Error(`User already has an assignment for this shift slot (assignmentId=${row.id}, status=${row.status}).`);
  e.httpStatus = 400;
  throw e;
}


// Normalize any PG date/timestamp value to a stable "YYYY-MM" key.
// pg can return DATE as string (YYYY-MM-DD) but TIMESTAMP/TZ often as JS Date.
// Using slice(0,7) on a Date's .toString() yields "Fri Jan" etc -> wrong.
function yearMonthKey(v) {
  if (v == null) return null;

  // JS Date (common for timestamptz depending on pg type parser)
  if (v instanceof Date) {
    const y = v.getUTCFullYear().toString().padStart(4, '0');
    const m = (v.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${y}-${m}`;
  }

  const s = String(v);
  if (!s) return null;

  // 'YYYY-MM-DD' or full ISO 'YYYY-MM-DDTHH:mm:ss...'
  const datePart = s.split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return datePart.slice(0, 7);
  }

  // Fallback: try to parse as a date string and compute UTC year-month
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getUTCFullYear().toString().padStart(4, '0');
    const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${y}-${m}`;
  }

  return null;
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
      whereClauses.push(`COALESCE(sr.division_id, sa.division_id) = $${index}`);
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
		 sr.requested_absence_type,
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
   return sendDbError(res, err, 'SHIFT REQUESTS LIST');
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
  let client;
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

    client = await pool.connect();
    await client.query('BEGIN');

    const rRes = await client.query(
      `SELECT *
         FROM shiftly_schema.shift_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId]
    );
    if (!rRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const r = rRes.rows[0];

    if (Number(r.requested_by_user_id) !== Number(actorUserId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only retract your own requests.' });
    }

    const status = String(r.request_status ?? '').toUpperCase();
    if (!isPendingStatus(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot retract request from status ${r.request_status}. Only pending requests can be retracted.`,
      });
    }

    await client.query(
      `DELETE FROM shiftly_schema.shift_requests WHERE id = $1`,
      [requestId]
    );

    await client.query('COMMIT');
    return res.json({ id: requestId, deleted: true });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Error retracting shift request:', err);
    return sendDbError(res, err, 'RETRACT SHIFT REQUEST');
  } finally {
    if (client) client.release();
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
	  requested_absence_type,
      absence_type, // allow client alias
      decision_comment,
    } = req.body;

      if (!request_type || !requested_by_user_id) {
      return res.status(400).json({ error: 'request_type and requested_by_user_id are required.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const effectiveDivisionId = division_id ?? divisionId ?? null;
    const typeUpper = String(request_type).toUpperCase();
	
	    // ---- OFF_REQUEST (absence request; goes through workflow like NEW_SHIFT) ----
    if (typeUpper === 'OFF_REQUEST') {
      if (!shift_assignment_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'OFF_REQUEST requires shift_assignment_id.' });
      }

      const effectiveAbsenceType = requested_absence_type ?? absence_type ?? null;
      if (!effectiveAbsenceType) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'OFF_REQUEST requires requested_absence_type (absence_type).' });
      }

      // Load the assignment (source of shift_date/division/department/shift_type)
      const aRes = await client.query(
        `SELECT * FROM shiftly_schema.shift_assignments WHERE id = $1 FOR UPDATE`,
        [shift_assignment_id]
      );
      if (!aRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'shift_assignment_id not found.' });
      }
      const a = aRes.rows[0];

      // Only the assignment owner can request off (day detail button is per-user anyway)
      if (Number(a.user_id) !== Number(requested_by_user_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You can only request off for your own assignment.' });
      }

      // If already absence, no need to request
      if (isAbsenceValue(a.is_absence)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This assignment is already marked as absence.' });
      }

      // If an absence already covers that day, reject to avoid duplicates
      const hasAbs = await userHasAbsenceOnDate(client, {
        userId: Number(requested_by_user_id),
        shiftDate: a.shift_date,
      });
      if (hasAbs) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You already have an absence covering this date.' });
      }

      let effectiveManagerId = manager_user_id ?? null;
      if (!effectiveManagerId) {
        effectiveManagerId = await getPrimaryManagerId(client, requested_by_user_id);
      }
      if (!effectiveManagerId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'User has no primary manager.' });
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
          requested_absence_type,
          created_at,
          last_action_at,
          last_action_by_user_id,
          decided_at,
          decision_by_user_id,
          decision_comment
        )
        VALUES (
          'OFF_REQUEST',
          'PENDING',
          $1,
          NULL,
          $2,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          NOW(),
          NOW(),
          $1,
          NULL,
          NULL,
          $9
        )
        RETURNING
          id, request_type, request_status, requested_by_user_id, target_user_id,
          manager_user_id, inbox_user_id, shift_assignment_id, division_id,
          requested_shift_date, requested_shift_type_id, requested_department_id,
          requested_absence_type,
          created_at, decided_at, decision_by_user_id, decision_comment,
          source_shift_assignment_id, target_shift_assignment_id, shift_offer_id,
          last_action_at, last_action_by_user_id
      `;

      const result = await client.query(insertQuery, [
        requested_by_user_id,
        effectiveManagerId,
        shift_assignment_id,
        (a.division_id ?? effectiveDivisionId ?? null),
        a.shift_date,
        a.shift_type_id,
        a.department_id,
        String(effectiveAbsenceType).toUpperCase(),
        decision_comment ?? null, // request comment (employee)
      ]);

      await client.query('COMMIT');
      return res.status(201).json(result.rows[0]);
    }


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
          last_action_at,
          last_action_by_user_id,
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
		  $10,
          NOW(),
          NOW(),
          $2,
          NULL,
          NULL,
          $11
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
      if (isAbsenceValue(src.is_absence) || isAbsenceValue(tgt.is_absence)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Absence assignments cannot be switched.' });
      }

      // Must be same month
     const monthSrc = yearMonthKey(src.shift_date);
     const monthTgt = yearMonthKey(tgt.shift_date);
     if (!monthSrc || !monthTgt || monthSrc !== monthTgt) {
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
	  
	  
      // ✅ IMPORTANT:
      // If both assignments are the exact SAME slot (same period/date/div/dept/shiftType),
      // swapping user_id will either be a no-op (semantically) or can transiently violate uq_assignment.
      // Reject at creation time.
      if (isSameAssignmentSlot(src, tgt)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Invalid SWITCH: source and target assignments are the same shift slot (same date/shift). Pick a different shift/date.',
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
         last_action_at,
         last_action_by_user_id,
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
        NOW(),
        $1,
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
        SELECT
          so.id                 AS offer_id,
          so.status             AS offer_status,
          so.shift_assignment_id,
          so.offered_by_user_id,
          so.visibility_scope,
          so.target_user_id,
          so.note,
          so.offered_at,
          so.original_assignment_status,

          sa.status             AS assignment_status,
          sa.shift_date,
          sa.division_id,
          sa.department_id,
          sa.shift_type_id,
          sa.staff_type_id,
          sa.user_id            AS assignment_owner_user_id,
          sa.is_absence
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

       if (String(row.offer_status).toUpperCase() !== 'ACTIVE') {
        await client.query('ROLLBACK');
         return res.status(400).json({ error: `Offer is not ACTIVE (current=${row.offer_status}).` });
      }
      if (isAbsenceValue(row.is_absence)) {
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
       last_action_at,
       last_action_by_user_id,
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
       NOW(),
        $1,
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
      res.status(500).json({
      error: 'Database error',
      message: err.message,
      code: err.code,
      detail: err.detail,
      constraint: err.constraint,
      table: err.table,
      column: err.column,
      schema: err.schema,
      routine: err.routine,
      where: err.where,
    });
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
	
    // Helper: finalize SWITCH swap + history with proper HTTP errors
    const finalizeSwitchSwap = async () => {
      const fail = (httpStatus, message) => {
        const e = new Error(message);
        e.httpStatus = httpStatus;
        throw e;
      };

      const srcId = r.source_shift_assignment_id ?? r.shift_assignment_id;
      const tgtId = r.target_shift_assignment_id;
      if (!srcId || !tgtId) {
        fail(400, 'Missing source/target assignment references for SWITCH.');
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
        fail(404, 'Source or target assignment not found.');
      }

      const src = srcRes.rows[0];
      const tgt = tgtRes.rows[0];
	  
	 
      // ✅ If approving a SWITCH means both users will work on the new dates,
      // remove those dates from any existing absences to avoid cancellations/conflicts.
      // - target user will receive src.shift_date
      // - source user will receive tgt.shift_date
      await removeAbsenceCoverageForDate(client, {
        userId: Number(r.target_user_id),
        shiftDate: src.shift_date,
        actorUserId: decision_by_user_id,
        reason: 'SWITCH_APPROVED_TARGET_DATE',
      });
      await removeAbsenceCoverageForDate(client, {
        userId: Number(r.requested_by_user_id),
        shiftDate: tgt.shift_date,
        actorUserId: decision_by_user_id,
        reason: 'SWITCH_APPROVED_SOURCE_DATE',
      });
	  
      // ✅ Prevent the known uq_assignment transient collision:
      // If both assignments represent the exact same slot (same period/date/div/dept/shiftType),
      // swapping user_id is either meaningless or will violate uq_assignment during the first UPDATE.
      if (isSameAssignmentSlot(src, tgt)) {
        fail(400, 'Cannot approve SWITCH: source and target assignments are the same shift slot (same date/shift). Create a new request selecting a different shift/date.');
      }

      // Re-validate overlap at approval time
      const excludeForTarget =
        (String(tgt.shift_date) === String(src.shift_date)) ? tgt.id : null;
      const excludeForSource =
        (String(src.shift_date) === String(tgt.shift_date)) ? src.id : null;

      const targetHasOverlap = await userHasOverlappingAssignment(client, {
        userId: Number(r.target_user_id),
        shiftDate: src.shift_date,
        shiftTypeId: src.shift_type_id,
        excludeAssignmentId: excludeForTarget,
      });
      if (targetHasOverlap) {
        fail(400, 'Target user has an overlapping shift at the source shift date/time.');
      }

      const sourceHasOverlap = await userHasOverlappingAssignment(client, {
        userId: Number(r.requested_by_user_id),
        shiftDate: tgt.shift_date,
        shiftTypeId: tgt.shift_type_id,
        excludeAssignmentId: excludeForSource,
      });
      if (sourceHasOverlap) {
        fail(400, 'Source user has an overlapping shift at the target shift date/time.');
      }

      const srcUser = src.user_id;
      const tgtUser = tgt.user_id;

      // ✅ Guard uq_assignment before we touch user_id.
      // This also cleans up CANCELLED duplicates that still block the UNIQUE constraint.
      await resolveUqAssignmentConflict(client, {
        shiftPeriodId: src.shift_period_id,
        shiftDate: src.shift_date,
        userId: tgtUser,
        shiftTypeId: src.shift_type_id,
        departmentId: src.department_id,
        divisionId: src.division_id,
        excludeAssignmentId: src.id,
      });

      await resolveUqAssignmentConflict(client, {
        shiftPeriodId: tgt.shift_period_id,
        shiftDate: tgt.shift_date,
        userId: srcUser,
        shiftTypeId: tgt.shift_type_id,
        departmentId: tgt.department_id,
        divisionId: tgt.division_id,
        excludeAssignmentId: tgt.id,
      });



      // Swap users
         try {
        await client.query(
          `UPDATE shiftly_schema.shift_assignments SET user_id = $1, updated_at = NOW() WHERE id = $2`,
          [tgtUser, src.id]
        );
        await client.query(
          `UPDATE shiftly_schema.shift_assignments SET user_id = $1, updated_at = NOW() WHERE id = $2`,
          [srcUser, tgt.id]
        );
      } catch (e) {
        // Convert uq_assignment violation to a clean 400 message (instead of leaking PG error to UI)
        if (e?.code === '23505' && String(e?.constraint || '').toLowerCase() === 'uq_assignment') {
          fail(400, 'Cannot approve SWITCH: the resulting assignment would duplicate an existing assignment slot for one of the users (uq_assignment).');
        }
        throw e;
      }

      // History
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
             ($1, $2, $3, 'SWITCH', $4, $5, $6, $7, $8, $9),
          ($10, $11, $12, 'SWITCH', $4, $13, $14, $15, $16, $9)
        `,
        [
          src.id,
          srcUser,
          tgtUser,
          r.id,
          src.shift_date,
          src.shift_type_id,
          src.department_id,
          src.division_id ?? null,
          decision_comment ?? null,
          tgt.id,
          tgtUser,
          srcUser,
          tgt.shift_date,
          tgt.shift_type_id,
          tgt.department_id,
          tgt.division_id ?? null,
        ]
      );
    };


    // NEW_SHIFT: single-step approve (legacy)
    if (type === 'NEW_SHIFT') {
		
		// ✅ If user previously had OFF_REQUEST approved for that date,
      // remove that date from user_absences so a new assignment can exist.
      await removeAbsenceCoverageForDate(client, {
        userId: r.requested_by_user_id,
        shiftDate: r.requested_shift_date,
        actorUserId: decision_by_user_id,
        reason: 'NEW_SHIFT_APPROVED',
      });

		
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
	
   // OFF_REQUEST: single-step approve (insert user_absences row; triggers do the rest)
    if (type === 'OFF_REQUEST') {
      if (status !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `OFF_REQUEST cannot be approved from status ${r.request_status}.` });
      }

      if (!r.requested_absence_type) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'OFF_REQUEST is missing requested_absence_type.' });
      }
      if (!r.requested_shift_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'OFF_REQUEST is missing requested_shift_date.' });
      }
	  
        if (!r.shift_assignment_id) {
       await client.query('ROLLBACK');
       return res.status(400).json({ error: 'OFF_REQUEST is missing shift_assignment_id.' });
     }

    // Lock assignment row (and ensure it still belongs to the requester)
     const asgRes = await client.query(
       `SELECT id, user_id, shift_date, shift_type_id, department_id, division_id
          FROM shiftly_schema.shift_assignments
         WHERE id = $1
         FOR UPDATE`,
       [r.shift_assignment_id]
     );
     if (!asgRes.rows.length) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'shift_assignment_id not found.' });
     }
     if (Number(asgRes.rows[0].user_id) !== Number(r.requested_by_user_id)) {
       await client.query('ROLLBACK');
       return res.status(400).json({ error: 'OFF_REQUEST assignment no longer belongs to the requesting user.' });
     }


      // Idempotent insert (avoid duplicate same-day absence)
      await client.query(
        `
        INSERT INTO shiftly_schema.user_absences
          (user_id, absence_type, start_date, end_date, created_by, comment)
        SELECT
          $1, $2, $3::date, $3::date, $4, $5
        WHERE NOT EXISTS (
          SELECT 1
            FROM shiftly_schema.user_absences ua
           WHERE ua.user_id = $1
             AND $3::date BETWEEN ua.start_date AND ua.end_date
        )
        `,
        [
          r.requested_by_user_id,
          String(r.requested_absence_type).toUpperCase(),
          r.requested_shift_date,
          decision_by_user_id,
          // store the employee request comment (decision_comment at creation)
          r.decision_comment ?? null,
        ]
      );
	  
	  // ✅ History: record OFF_REQUEST approval (idempotent)
      const histComment = (() => {
        const parts = [];
        if (decision_comment != null && String(decision_comment).trim() !== '') {
          parts.push(String(decision_comment).trim());
        }
        parts.push(`ABSENCE_TYPE=${String(r.requested_absence_type).toUpperCase()}`);
        return parts.length ? parts.join(' | ') : null;
      })();

      const histExists = await client.query(
        `
        SELECT 1
          FROM shiftly_schema.shift_assignment_user_history h
         WHERE h.shift_assignment_id = $1
           AND h.shift_request_id = $2
           AND h.change_reason = 'OFF_REQUEST'
         LIMIT 1
        `,
        [r.shift_assignment_id, id]
      );
      if (!histExists.rows.length) {
		  const a = asgRes.rows[0];
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
                 ($1, $2, $2, 'OFF_REQUEST', $3, $4, $5, $6, $7, $8)
          `,
           [
             r.shift_assignment_id,
             r.requested_by_user_id,
             id,
             a.shift_date,
             a.shift_type_id,
             a.department_id,
             a.division_id ?? null,
             histComment,
           ]
        );
      }


      const upd = await client.query(
        `
        UPDATE shiftly_schema.shift_requests
           SET request_status      = 'APPROVED',
               inbox_user_id       = NULL,
               decided_at          = NOW(),
               decision_by_user_id = $1,
               -- do NOT overwrite the employee request comment unless manager provides one
               decision_comment    = COALESCE($2, decision_comment),
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
         // next: target manager (or skip if common manager)
        const targetManagerId = await getPrimaryManagerId(client, r.target_user_id);
		
	       if (!targetManagerId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Target user has no primary manager.' });
        }
		
		

       const sourceManagerId = await getPrimaryManagerId(client, r.requested_by_user_id);
        if (!sourceManagerId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Source user has no primary manager.' });
        }

        const sameManager = Number(targetManagerId) === Number(sourceManagerId);
        const nextInboxUserId = sameManager ? sourceManagerId : targetManagerId;
        const nextStatus = sameManager ? 'PENDING_SOURCE_MANAGER' : 'PENDING_TARGET_MANAGER';

		
		
        const upd = await client.query(
          `
          UPDATE shiftly_schema.shift_requests
         SET request_status = $1,
                 inbox_user_id  = $2,
                 last_action_at = NOW(),
                 last_action_by_user_id = $3,
                decision_comment = COALESCE($4, decision_comment)
          WHERE id = $5
           RETURNING *
          `,
               [
            nextStatus,
            nextInboxUserId,
            decision_by_user_id,
            decision_comment ?? null,
            id,
          ]
        );
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      }

      if (status === 'PENDING_TARGET_MANAGER') {
        // next: source manager
        const sourceManagerId = await getPrimaryManagerId(client, r.requested_by_user_id);
		
	       if (!sourceManagerId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Source user has no primary manager.' });
        }
		
	      // ✅ If both users share the SAME manager, don't require a second approval.
        // This handles:
        //  - old rows that already reached PENDING_TARGET_MANAGER
        //  - common-manager setups (manager approves ONCE only)
        if (Number(sourceManagerId) === Number(decision_by_user_id)) {
          try {
            await finalizeSwitchSwap();
          } catch (e) {
            await client.query('ROLLBACK');
            return res.status(e.httpStatus ?? 400).json({
              error: String(e.message || e),
            });
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
        try {
          await finalizeSwitchSwap();
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(e.httpStatus ?? 400).json({
            error: String(e.message || e),
          });
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
               SELECT
            so.id                 AS offer_id,
            so.status             AS offer_status,
            so.shift_assignment_id,
            so.offered_by_user_id,
            so.taken_by_user_id,
            so.taken_at,
            so.cancelled_by_user_id,
            so.cancelled_at,
            so.visibility_scope,
            so.target_user_id,
            so.note,
            so.offered_at,
            so.original_assignment_status,
			sa.shift_period_id,
            sa.status             AS assignment_status,
            sa.shift_date,
            sa.division_id,
            sa.department_id,
            sa.shift_type_id,
            sa.staff_type_id,
            sa.user_id            AS assignment_owner_user_id,
            sa.is_absence
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
             if (String(row.offer_status).toUpperCase() !== 'ACTIVE') {
         throw new Error(`Offer is not ACTIVE (current=${row.offer_status}).`);
        }
		
		        // ✅ Requesting user is going to take this shift date -> remove that date
        // from any existing absences so the assignment won't be considered "absent".
        await removeAbsenceCoverageForDate(client, {
          userId: Number(r.requested_by_user_id),
          shiftDate: row.shift_date,
          actorUserId: decision_by_user_id,
          reason: 'OFFER_APPROVED',
        });

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
		
		       // ✅ Guard uq_assignment before transferring ownership.
        // Also auto-deletes CANCELLED duplicates that still block uq_assignment.
        await resolveUqAssignmentConflict(client, {
          shiftPeriodId: row.shift_period_id,
          shiftDate: row.shift_date,
          userId: toUser,
          shiftTypeId: row.shift_type_id,
          departmentId: row.department_id,
          divisionId: row.division_id,
          excludeAssignmentId: row.shift_assignment_id,
        });


           try {
          await client.query(
            `UPDATE shiftly_schema.shift_assignments SET user_id = $1, status = 'APPROVED', updated_at = NOW() WHERE id = $2`,
            [toUser, row.shift_assignment_id]
          );
        } catch (e) {
          if (e?.code === '23505' && String(e?.constraint || '').toLowerCase() === 'uq_assignment') {
            const err = new Error('Cannot approve OFFER: the requesting user already has the same assignment slot (uq_assignment).');
            err.httpStatus = 400;
            throw err;
          }
          throw e;
        }
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
            (
              shift_assignment_id,
              from_user_id,
              to_user_id,
              change_reason,
              shift_request_id,
              shift_offer_id,
              shift_date,
              shift_type_id,
              department_id,
              division_id,
              comment
            )
          VALUES
            ($1, $2, $3, 'OFFER', $4, $5, $6, $7, $8, $9, $10)
          `,
         [
           row.shift_assignment_id,
           fromUser,
           toUser,
           r.id,
           offerId,
           row.shift_date,
           row.shift_type_id,
           row.department_id,
           row.division_id ?? null,
           decision_comment ?? null,
         ]
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
          return res.status(e.httpStatus ?? 400).json({ error: String(e.message || e) });
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
         return res.status(e.httpStatus ?? 400).json({ error: String(e.message || e) });
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
   return sendDbError(res, err, 'APPROVE SHIFT REQUEST');
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
    return sendDbError(res, err, 'ATTACH ASSIGNMENT');
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
              decision_comment    = COALESCE($2, decision_comment),
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
     return sendDbError(res, err, 'REJECT SHIFT REQUEST');
  } finally {
if (client) client.release();
  }
});

module.exports = router;


