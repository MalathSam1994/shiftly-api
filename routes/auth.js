// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// Login endpoint: username = empno
router.post('/login', async (req, res) => {
 const usernameRaw = (req.body.username ?? '').toString();
 const passwordRaw = (req.body.password ?? '').toString();
 const usernameNorm = usernameRaw.replace(/\s+/g, '').toUpperCase(); // remove ALL spaces
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
             password_hash
      FROM shiftly_schema.users
      WHERE regexp_replace(upper(empno), '\\s+', '', 'g') = $1
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
        SET session_version = session_version + 1
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
          session_version = session_version + 1
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
