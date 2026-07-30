const express = require('express');
const router = express.Router();
const pool = require('../db');
const { sendApiError, sendInternalError } = require('../utils/apiError');

// POST /fcm/register
// { userId: 1, token: "...", platform: "android" }
router.post('/register', async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const token = String(req.body.token || '').trim();
    const platform = String(req.body.platform || '').trim();


    console.log('[FCM REGISTER] incoming', {
      userId,
      platform,
      tokenLength: token.length,
      authUserId: req.user?.id ?? req.user?.sub ?? null,
    });



    if (!userId) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A user is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!token) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A notification token is required.',
        code: 'INVALID_REQUEST',
      });
    }

    // Upsert by token (token must be unique).
    const sql = `
      INSERT INTO shiftly_schema.user_fcm_tokens (user_id, token, platform, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (token)
      DO UPDATE SET user_id = EXCLUDED.user_id,
                    platform = EXCLUDED.platform,
                    updated_at = CURRENT_TIMESTAMP
    `;

    await pool.query(sql, [userId, token, platform]);
    console.log('[FCM REGISTER] saved', { userId, platform });
    res.json({ ok: true });
  } catch (e) {
    return sendInternalError(req, res, e, 'FCM registration failed');
  }
});

module.exports = router;
