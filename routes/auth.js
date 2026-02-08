// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middleware/requireAuth');


const router = express.Router();
const { generateComplexPassword } = require('../services/passwordUtil');
const { sendResetPasswordEmail } = require('../services/mailer');

// Login endpoint: username = user_name
router.post('/login', async (req, res) => {
  const usernameRaw = (req.body.username ?? '').toString();
  const passwordRaw = (req.body.password ?? '').toString();
  // Normalize user_name for login:
  // - trim ends
  // - collapse internal whitespace to a single space
  // - compare case-insensitively
  const usernameNorm = usernameRaw.trim().replace(/\s+/g, ' ').toLowerCase();
  const password = passwordRaw;
 

if (!usernameNorm || !password) {
    return res
      .status(400)
      .json({ error: 'Username and password are required.' });
  }

  try {
    const query = `
      SELECT id,
             empno,
             user_name,
             user_desc,
             user_type,
             role_id,
             session_version,
             email,
              must_change_password,
             password_hash
      FROM shiftly_schema.users
      WHERE regexp_replace(lower(trim(user_name)), '\\s+', ' ', 'g') = $1
    `;
   const result = await pool.query(query, [usernameNorm]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

         // ✅ Enforce "single active session" per user:
    // Every login bumps session_version, invalidating tokens issued before.
    const bump = await pool.query(
      `
        UPDATE shiftly_schema.users
       SET session_version = COALESCE(session_version, 0) + 1
        WHERE id = $1
        RETURNING session_version
      `,
      [user.id],
    );
    const sessionVersion = bump.rows[0]?.session_version ?? 0;


    // Do not send password_hash back to the client
    const { password_hash, ...safeUser } = user;

    // Issue JWT
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is missing in env');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const token = jwt.sign(
      {
        sub: safeUser.id,
        role_id: safeUser.role_id ?? null,
        user_type: safeUser.user_type ?? null,
         sv: sessionVersion, // session version claim
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' },
    );

    return res.json({ ...safeUser, token });
  } catch (err) {
    console.error('Error during login:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Forgot password:
// - User enters email
// - If exists -> generate temp password, set must_change_password = true
// - Email temp password
router.post('/forgot-password', async (req, res) => {
  const emailRaw = (req.body.email ?? '').toString().trim();
  if (!emailRaw) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const find = await client.query(
      `
      SELECT id, user_name, email
      FROM shiftly_schema.users
      WHERE lower(trim(email)) = lower(trim($1))
      `,
      [emailRaw],
    );

    // For security, respond OK even if not found (avoid user enumeration).
    if (find.rows.length === 0) {
      await client.query('COMMIT');
      return res.json({ message: 'If the email exists, a reset has been sent.' });
    }

    const u = find.rows[0];
    const tempPassword = generateComplexPassword(14);
    const newHash = await bcrypt.hash(tempPassword, 10);

    // Also rotate session_version to sign out other devices
    await client.query(
      `
      UPDATE shiftly_schema.users
      SET password_hash = $1,
          must_change_password = TRUE,
             session_version = COALESCE(session_version, 0) + 1
      WHERE id = $2
      `,
      [newHash, u.id],
    );

    await sendResetPasswordEmail({
      to: u.email,
      username: u.user_name,
      tempPassword,
    });

    await client.query('COMMIT');
    return res.json({ message: 'If the email exists, a reset has been sent.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Error during forgot-password:', err);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});


// Change password endpoint
// Requires JWT so users can only change their own password.
router.post('/change-password', requireAuth, async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;

  if (!userId || !currentPassword || !newPassword) {
    return res
      .status(400)
      .json({ error: 'userId, currentPassword and newPassword are required.' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: 'New password must be at least 8 characters long.',
    });
  }

  // Ensure the token owner matches the requested userId
  if (Number(req.user?.sub) !== Number(userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }


  try {
    const selectQuery = `
      SELECT id, password_hash, session_version, role_id, user_type, empno, user_name, user_desc
      FROM shiftly_schema.users
      WHERE id = $1
    `;
    const selectResult = await pool.query(selectQuery, [userId]);

    if (selectResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = selectResult.rows[0];

    const matches = await bcrypt.compare(
      currentPassword,
      user.password_hash
    );

    if (!matches) {
      return res
        .status(401)
        .json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

      // Update password AND rotate session_version (sign out other devices)
    const updateQuery = `
      UPDATE shiftly_schema.users
      SET password_hash = $1,
      must_change_password = FALSE,
         session_version = COALESCE(session_version, 0) + 1    
      WHERE id = $2
      RETURNING session_version
    `;
    const upd = await pool.query(updateQuery, [newHash, userId]);
    const sessionVersion = upd.rows[0]?.session_version ?? (user.session_version ?? 0) + 1;

    // Issue a fresh token for THIS session so user doesn't get kicked out immediately.
    const token = jwt.sign(
      {
        sub: Number(userId),
        role_id: user.role_id ?? null,
        user_type: user.user_type ?? null,
        sv: sessionVersion,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' },
    );

    return res.json({ message: 'Password updated successfully.', token });
  } catch (err) {
    console.error('Error changing password:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
