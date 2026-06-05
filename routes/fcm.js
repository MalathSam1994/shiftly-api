const express = require('express');
const router = express.Router();
const pool = require('../db');

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
      tokenPrefix: token.substring(0, token.length > 18 ? 18 : token.length),
      authUserId: req.user?.id ?? req.user?.sub ?? null,
    });



    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!token) return res.status(400).json({ error: 'token is required' });

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
    console.error('[FCM REGISTER] failed', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
