const express = require('express');
const router = express.Router();

const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

// GET /notifications/department-targets
//
// Returns one selectable entry per division/department combination.
// This prevents ambiguity when two divisions contain departments with
// the same description.
router.get('/department-targets', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        dd.division_id,
        dd.department_id,
        v.division_desc,
        d.department_desc
      FROM shiftly_schema.division_departments AS dd
      JOIN shiftly_schema.divisions AS v
        ON v.id = dd.division_id
      JOIN shiftly_schema.departments AS d
        ON d.id = dd.department_id
      WHERE v.is_active = true
        AND d.is_active = true
      ORDER BY
        v.division_desc,
        d.department_desc,
        dd.division_id,
        dd.department_id
    `);

    return res.json(rows);
  } catch (e) {
    return sendPostgresError(req, res, e, {
      action: 'LIST',
      label: 'Error loading notification department targets',
    });
  }
});

// GET /notifications?recipientUserId=1&unreadOnly=true
router.get('/', async (req, res) => {
  try {
    const recipientUserId = Number(req.query.recipientUserId);
    const unreadOnly = String(req.query.unreadOnly || 'false') === 'true';

    if (!recipientUserId) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A recipient user is required.',
        code: 'INVALID_REQUEST',
      });
    }

    const params = [recipientUserId];
    let where = 'WHERE recipient_user_id = $1';
    if (unreadOnly) {
      where += ' AND is_read = false';
    }

    const sql = `
      SELECT id, recipient_user_id, notification_type, title, body, payload,
             is_read, created_at, read_at
      FROM shiftly_schema.notifications
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT 500
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    return sendPostgresError(req, res, e, {
      action: 'LIST',
      label: 'Error loading notifications',
    });
  }
});

// POST /notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return sendApiError(req, res, {
        status: 400,
        error: 'The notification id is invalid.',
        code: 'INVALID_REQUEST',
      });
    }

    const sql = `
      UPDATE shiftly_schema.notifications
      SET is_read = true, read_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [id]);
    res.json(rows[0] || null);
  } catch (e) {
    return sendPostgresError(req, res, e, {
      action: 'UPDATE',
      label: 'Error marking notification read',
    });
  }
});

// POST /notifications/mark-all-read  { recipientUserId: 1 }
router.post('/mark-all-read', async (req, res) => {
  try {
    const recipientUserId = Number(req.body.recipientUserId);
    if (!recipientUserId) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A recipient user is required.',
        code: 'INVALID_REQUEST',
      });
    }
    const sql = `
      UPDATE shiftly_schema.notifications
      SET is_read = true, read_at = CURRENT_TIMESTAMP
      WHERE recipient_user_id = $1 AND is_read = false
    `;
    await pool.query(sql, [recipientUserId]);
    res.json({ ok: true });
  } catch (e) {
    return sendPostgresError(req, res, e, {
      action: 'UPDATE',
      label: 'Error marking notifications read',
    });
  }
});

// POST /notifications/push
// Body:
//  - title (required)
//  - body (optional)
//  - recipientUserId (optional)
//  - departmentId (optional)
//  - divisionId (required together with departmentId)
//  - allUsers (optional boolean)
//  - payload (optional JSON)
//
// Exactly one target must be supplied:
//  - one active user
//  - one division/department combination
//  - all active users
router.post('/push', async (req, res) => {
  try {

    const title = String(req.body.title || '').trim();
    const body = (req.body.body == null) ? null : String(req.body.body);

    const rawRecipientUserId =
      req.body.recipientUserId ??
      req.body.recipient_user_id ??
      req.body.user_id ??
      null;

    const rawDepartmentId =
      req.body.departmentId ??
      req.body.department_id ??
      null;

    const rawDivisionId =
      req.body.divisionId ??
      req.body.division_id ??
      null;

    const rawAllUsers =
      req.body.allUsers ??
      req.body.all_users ??
      false;

    const recipientUserId =
      rawRecipientUserId == null || rawRecipientUserId === ''
        ? null
        : Number(rawRecipientUserId);

    const departmentId =
      rawDepartmentId == null || rawDepartmentId === ''
        ? null
        : Number(rawDepartmentId);

    const divisionId =
      rawDivisionId == null || rawDivisionId === ''
        ? null
        : Number(rawDivisionId);

    const allUsers =
      rawAllUsers === true ||
      String(rawAllUsers).trim().toLowerCase() === 'true';

    const payload =
      req.body.payload ??
      req.body.data ??
      null;

    console.log('[NOTIFICATIONS PUSH] incoming', {
      title,
      recipientUserId,
      departmentId,
      divisionId,
      allUsers,
      payload,
    });
 

    if (!title) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A notification title is required.',
        code: 'INVALID_REQUEST',
      });
    }

    if (
      recipientUserId != null &&
      (!Number.isInteger(recipientUserId) || recipientUserId <= 0)
    ) {
      return sendApiError(req, res, {
        status: 400,
      error: 'The recipient user is invalid.',
        code: 'INVALID_REQUEST',
      });
    }


    if (
      departmentId != null &&
      (!Number.isInteger(departmentId) || departmentId <= 0)
    ) {
      return sendApiError(req, res, {
        status: 400,
        error: 'The department is invalid.',
        code: 'INVALID_REQUEST',
      });
    }

    if (
      divisionId != null &&
      (!Number.isInteger(divisionId) || divisionId <= 0)
    ) {
      return sendApiError(req, res, {
        status: 400,
        error: 'The division is invalid.',
        code: 'INVALID_REQUEST',
      });
    }

    const hasUserTarget = recipientUserId != null;
    const hasDepartmentTarget =
      departmentId != null || divisionId != null;

    if (
      hasDepartmentTarget &&
      (departmentId == null || divisionId == null)
    ) {
      return sendApiError(req, res, {
        status: 400,
        error:
          'Both a department and its division are required for a department notification.',
        code: 'INVALID_REQUEST',
      });
    }

    const selectedTargetCount = [
      hasUserTarget,
      hasDepartmentTarget,
      allUsers,
    ].filter(Boolean).length;

    if (selectedTargetCount !== 1) {
      return sendApiError(req, res, {
        status: 400,
        error:
          'Choose exactly one notification target: user, department, or all users.',
        code: 'INVALID_REQUEST',
      });
    }


    let userIds = [];
    if (hasUserTarget) {
      const { rows } = await pool.query(
        `SELECT id
         FROM shiftly_schema.users
         WHERE id = $1 AND is_active = true`,
        [recipientUserId]
      );
      userIds = rows.map(r => r.id);
    } else if (hasDepartmentTarget) {
      const { rows } = await pool.query(
        `
        SELECT DISTINCT u.id
        FROM shiftly_schema.users AS u
        JOIN shiftly_schema.user_department AS ud
          ON ud.user_id = u.id
         AND ud.department_id = $1
        JOIN shiftly_schema.user_divisions AS uv
          ON uv.user_id = u.id
         AND uv.division_id = $2
        JOIN shiftly_schema.division_departments AS dd
          ON dd.department_id = ud.department_id
         AND dd.division_id = uv.division_id
        JOIN shiftly_schema.departments AS d
          ON d.id = ud.department_id
        JOIN shiftly_schema.divisions AS v
          ON v.id = uv.division_id
        WHERE u.is_active = true
          AND ud.is_active = true
          AND uv.is_active = true
          AND d.is_active = true
          AND v.is_active = true
        ORDER BY u.id
        `,
        [departmentId, divisionId],
      );

      userIds = rows.map(r => r.id);
    } else {
      const { rows } = await pool.query(`
        SELECT id
        FROM shiftly_schema.users
        WHERE is_active = true
        ORDER BY id
      `);

      userIds = rows.map(r => r.id);
    }

    if (userIds.length === 0) {
      return res.json({
        ok: true,
        inserted: 0,
      });
    }

    const insertSql = `
      INSERT INTO shiftly_schema.notifications
        (recipient_user_id, notification_type, title, body, payload)
      SELECT
        target.user_id,
        'MANUAL',
        $2,
        $3,
        $4::jsonb
      FROM unnest($1::int[]) AS target(user_id)
    `;

    const insertResult = await pool.query(insertSql, [
      userIds,
      title,
      body,
      payload == null ? null : JSON.stringify(payload),
    ]);

    console.log('[NOTIFICATIONS PUSH] rows inserted', {
      requestedRecipients: userIds.length,
      inserted: insertResult.rowCount,
      title,
    });

    // No direct FCM call here.
    // ALL pushes (manual + trigger-generated) are sent by notificationDispatcher
    // when rows are inserted into shiftly_schema.notifications.
    return res.json({
      ok: true,
      inserted: insertResult.rowCount,
    });

  } catch (e) {
    return sendPostgresError(req, res, e, {
      action: 'CREATE',
      label: 'Notification push failed',
    });
  }
});

module.exports = router;
