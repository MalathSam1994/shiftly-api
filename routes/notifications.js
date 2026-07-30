const express = require('express');
const router = express.Router();

// Adjust these imports to your project structure:
const pool = require('../db'); // <- your pg Pool export
const { sendApiError, sendInternalError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');


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
//  - payload (optional JSON)
// Creates MANUAL notifications for a specific user or all users in a department.
router.post('/push', async (req, res) => {
  try {

    const title = String(req.body.title || '').trim();
    const body = (req.body.body == null) ? null : String(req.body.body);
    const recipientUserId = req.body.recipientUserId == null ? null : Number(req.body.recipientUserId);
    const departmentId = req.body.departmentId == null ? null : Number(req.body.departmentId);
    const payload = req.body.payload == null ? null : req.body.payload;

       console.log('[NOTIFICATIONS PUSH] incoming', {
     title,
     recipientUserId,
     departmentId,
     payload,
   });

    if (!title) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A notification title is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!recipientUserId && !departmentId) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Choose a recipient user or department.',
        code: 'INVALID_REQUEST',
      });
    }

    let userIds = [];
    if (recipientUserId) {
      const { rows } = await pool.query(
        `SELECT id
         FROM shiftly_schema.users
         WHERE id = $1 AND is_active = true`,
        [recipientUserId]
      );
      userIds = rows.map(r => r.id);
    } else {
      const { rows } = await pool.query(
        `SELECT DISTINCT ud.user_id
         FROM shiftly_schema.user_departments ud
         JOIN shiftly_schema.users u ON u.id = ud.user_id
         JOIN shiftly_schema.departments d ON d.id = ud.department_id
         WHERE ud.department_id = $1
           AND ud.is_active = true
           AND u.is_active = true
           AND d.is_active = true`,
        [departmentId]
      );
      userIds = rows.map(r => r.user_id);
    }

    if (userIds.length === 0) return res.json({ ok: true, inserted: 0 });

    const insertSql = `
      INSERT INTO shiftly_schema.notifications
        (recipient_user_id, notification_type, title, body, payload)
      VALUES ($1, 'MANUAL', $2, $3, $4)
    `;

    for (const uid of userIds) {
      console.log('[NOTIFICATIONS PUSH] inserting row', {
        recipientUserId: uid,
        title,
      });
      await pool.query(insertSql, [uid, title, body, payload]);
    }
	
    // ✅ NO direct FCM here anymore.
    // ALL pushes (manual + trigger-generated) are sent by notificationDispatcher
    // when rows are inserted into shiftly_schema.notifications.
    res.json({ ok: true, inserted: userIds.length });

  } catch (e) {
     return sendInternalError(req, res, e, 'Notification push failed');
  }
});

module.exports = router;
