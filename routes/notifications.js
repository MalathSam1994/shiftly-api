const express = require('express');
const router = express.Router();

// Adjust these imports to your project structure:
const pool = require('../db'); // <- your pg Pool export


// GET /notifications?recipientUserId=1&unreadOnly=true
router.get('/', async (req, res) => {
  try {
    const recipientUserId = Number(req.query.recipientUserId);
    const unreadOnly = String(req.query.unreadOnly || 'false') === 'true';

    if (!recipientUserId) {
      return res.status(400).json({ error: 'recipientUserId is required' });
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
    res.status(500).json({ error: e.message });
  }
});

// POST /notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const sql = `
      UPDATE shiftly_schema.notifications
      SET is_read = true, read_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const { rows } = await pool.query(sql, [id]);
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /notifications/mark-all-read  { recipientUserId: 1 }
router.post('/mark-all-read', async (req, res) => {
  try {
    const recipientUserId = Number(req.body.recipientUserId);
    if (!recipientUserId) {
      return res.status(400).json({ error: 'recipientUserId is required' });
    }
    const sql = `
      UPDATE shiftly_schema.notifications
      SET is_read = true, read_at = CURRENT_TIMESTAMP
      WHERE recipient_user_id = $1 AND is_read = false
    `;
    await pool.query(sql, [recipientUserId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!recipientUserId && !departmentId) {
      return res.status(400).json({ error: 'recipientUserId or departmentId is required' });
    }

    let userIds = [];
    if (recipientUserId) {
      userIds = [recipientUserId];
    } else {
      // Adjust table name if yours differs:
      // We assume: shiftly_schema.user_departments(user_id, department_id)
      const { rows } = await pool.query(
        `SELECT DISTINCT user_id FROM shiftly_schema.user_department WHERE department_id = $1`,
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
      await pool.query(insertSql, [uid, title, body, payload]);
    }
	
    // ✅ NO direct FCM here anymore.
    // ALL pushes (manual + trigger-generated) are sent by notificationDispatcher
    // when rows are inserted into shiftly_schema.notifications.
    res.json({ ok: true, inserted: userIds.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
