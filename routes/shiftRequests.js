
const express = require('express');
const pool = require('../db');

const router = express.Router();

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
    const { managerUserId, requestedByUserId, requestStatus } = req.query;

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

    if (managerUserId) {
      const managerId = parseInt(managerUserId, 10);
      values.push(managerId);
      const index = values.length;

      // Match either directly by sr.manager_user_id OR via user_managers mapping
      whereClauses.push(
        `(sr.manager_user_id = $${index}
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
        sr.shift_assignment_id,
        sr.requested_shift_date,
        sr.requested_shift_type_id,
        sr.requested_department_id,
        sr.created_at,
        sr.decided_at,
        sr.decision_by_user_id,
        sr.decision_comment
      FROM shiftly_schema.shift_requests sr
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
 *  - requested_shift_date (required, YYYY-MM-DD)
 *  - requested_shift_type_id (required)
 *  - requested_department_id (required)
 *  - decision_comment (optional, used here as "request comment" from employee)
 */
router.post('/', async (req, res) => {
  try {
    const {
      request_type,
      requested_by_user_id,
      target_user_id,
      manager_user_id,
      shift_assignment_id,
      requested_shift_date,
      requested_shift_type_id,
      requested_department_id,
      decision_comment,
    } = req.body;

    if (
      !request_type ||
      !requested_by_user_id ||
      !requested_shift_date ||
      !requested_shift_type_id ||
      !requested_department_id
    ) {
      return res.status(400).json({
        error:
          'request_type, requested_by_user_id, requested_shift_date, requested_shift_type_id and requested_department_id are required.',
      });
    }

    let effectiveManagerId = manager_user_id ?? null;

    // If manager_user_id is not provided, try to get the primary manager
    // from shiftly_schema.user_managers.
    if (!effectiveManagerId) {
      const managerResult = await pool.query(
        `
          SELECT manager_user_id
            FROM shiftly_schema.user_managers
           WHERE user_id = $1
             AND is_primary = TRUE
           ORDER BY id
           LIMIT 1
        `,
        [requested_by_user_id]
      );

      if (managerResult.rows.length > 0) {
        effectiveManagerId = managerResult.rows[0].manager_user_id;
      }
    }

    const insertQuery = `
      INSERT INTO shiftly_schema.shift_requests (
        request_type,
        request_status,
        requested_by_user_id,
        target_user_id,
        manager_user_id,
        shift_assignment_id,
        requested_shift_date,
        requested_shift_type_id,
        requested_department_id,
        created_at,
        decided_at,
        decision_by_user_id,
        decision_comment
      )
      VALUES (
        $1,         -- request_type
        'PENDING',  -- request_status
        $2,         -- requested_by_user_id
        $3,         -- target_user_id
        $4,         -- manager_user_id (can be null if no mapping exists)
        $5,         -- shift_assignment_id
        $6,         -- requested_shift_date
        $7,         -- requested_shift_type_id
        $8,         -- requested_department_id
        NOW(),      -- created_at
        NULL,       -- decided_at
        NULL,       -- decision_by_user_id
        $9          -- decision_comment (request comment)
      )
      RETURNING
        id,
        request_type,
        request_status,
        requested_by_user_id,
        target_user_id,
        manager_user_id,
        shift_assignment_id,
        requested_shift_date,
        requested_shift_type_id,
        requested_department_id,
        created_at,
        decided_at,
        decision_by_user_id,
        decision_comment
    `;

    const insertValues = [
      request_type,
      requested_by_user_id,
      target_user_id ?? null,
      effectiveManagerId,
      shift_assignment_id ?? null,
      requested_shift_date,
      requested_shift_type_id,
      requested_department_id,
      decision_comment ?? null,
    ];

    const result = await pool.query(insertQuery, insertValues);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error inserting into DB (SHIFT REQUESTS CREATE):', err);
    res.status(500).json({ error: 'Database error' });
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
    const { id } = req.params;
    const { decision_by_user_id, decision_comment } = req.body;

    if (!decision_by_user_id) {
      return res.status(400).json({
        error: 'decision_by_user_id is required to approve a request.',
      });
    }

    const query = `
      UPDATE shiftly_schema.shift_requests
         SET request_status      = 'APPROVED',
             decided_at          = NOW(),
             decision_by_user_id = $1,
             decision_comment    = $2
       WHERE id = $3
       RETURNING
         id,
         request_type,
         request_status,
         requested_by_user_id,
         target_user_id,
         manager_user_id,
         shift_assignment_id,
         requested_shift_date,
         requested_shift_type_id,
         requested_department_id,
         created_at,
         decided_at,
         decision_by_user_id,
         decision_comment
    `;

    const values = [decision_by_user_id, decision_comment ?? null, id];

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error approving shift request:', err);
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
  try {
    const { id } = req.params;
    const { decision_by_user_id, decision_comment } = req.body;

    if (!decision_by_user_id) {
      return res.status(400).json({
        error: 'decision_by_user_id is required to reject a request.',
      });
    }

    const query = `
      UPDATE shiftly_schema.shift_requests
         SET request_status      = 'REJECTED',
             decided_at          = NOW(),
             decision_by_user_id = $1,
             decision_comment    = $2
       WHERE id = $3
       RETURNING
         id,
         request_type,
         request_status,
         requested_by_user_id,
         target_user_id,
         manager_user_id,
         shift_assignment_id,
         requested_shift_date,
         requested_shift_type_id,
         requested_department_id,
         created_at,
         decided_at,
         decision_by_user_id,
         decision_comment
    `;

    const values = [decision_by_user_id, decision_comment ?? null, id];

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error rejecting shift request:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;


