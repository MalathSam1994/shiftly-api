// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

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

    // Do not send password_hash back to the client
    const { password_hash, ...safeUser } = user;

    return res.json(safeUser);
  } catch (err) {
    console.error('Error during login:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Change password endpoint
router.post('/change-password', async (req, res) => {
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

  try {
    const selectQuery = `
      SELECT id, password_hash
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

    const updateQuery = `
      UPDATE shiftly_schema.users
      SET password_hash = $1
      WHERE id = $2
    `;
    await pool.query(updateQuery, [newHash, userId]);

    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Error changing password:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
