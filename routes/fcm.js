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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
