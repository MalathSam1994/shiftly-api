// routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

// GET /users -> list all users (without password_hash)
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT id,
             empno,
             user_name,
             user_desc,
             user_type,
             role_id,
			 staff_type_id
      FROM shiftly_schema.users
      ORDER BY id
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error querying DB (USERS LIST):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /users/:id -> single user (without password_hash)
router.get('/:id', async (req, res) => {
  try {
    const query = `
      SELECT id,
             empno,
             user_name,
             user_desc,
             user_type,
             role_id,
			 staff_type_id
      FROM shiftly_schema.users
      WHERE id = $1
    `;
    const result = await pool.query(query, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error querying DB (USERS GET BY ID):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /users -> create a new user with hashed password
router.post('/', async (req, res) => {
  try {
    const {
      empno,
      user_name,
      user_desc,
      user_type,
      role_id,
	  staff_type_id,
      password,
    } = req.body;

    if (!empno || !user_name || !user_type || !password) {
      return res.status(400).json({
        error:
          'empno, user_name, user_type and password are required to create a user.',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters long.',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO shiftly_schema.users
        (empno, user_name, user_desc, user_type, role_id, staff_type_id, password_hash)
      VALUES
        ($1,    $2,        $3,        $4,        $5,      $6,      $7)
      RETURNING id,
                empno,
                user_name,
                user_desc,
                user_type,
                role_id,
				staff_type_id
    `;

    const values = [
      empno,
      user_name,
      user_desc ?? null,
      user_type,
      role_id ?? null,
	  staff_type_id ?? null,
      hashedPassword,
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error inserting into DB (USERS CREATE):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /users/:id -> update user data (without changing password)
router.put('/:id', async (req, res) => {
  try {
    const {
      empno,
      user_name,
      user_desc,
      user_type,
      role_id,
	  staff_type_id,
    } = req.body;

    if (!empno || !user_name || !user_type) {
      return res.status(400).json({
        error: 'empno, user_name and user_type are required for update.',
      });
    }

    const query = `
      UPDATE shiftly_schema.users
      SET empno = $1,
          user_name = $2,
          user_desc = $3,
          user_type = $4,
          role_id = $5,
		  staff_type_id = $6
      WHERE id = $7
      RETURNING id,
                empno,
                user_name,
                user_desc,
                user_type,
                role_id,
				staff_type_id
    `;

    const values = [
      empno,
      user_name,
      user_desc ?? null,
      user_type,
      role_id ?? null,
	  staff_type_id ?? null,
      req.params.id,
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating DB (USERS UPDATE):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /users/:id -> delete user
router.delete('/:id', async (req, res) => {
  try {
    const query = `
      DELETE FROM shiftly_schema.users
      WHERE id = $1
      RETURNING id,
                empno,
                user_name,
                user_desc,
                user_type,
                role_id,
				staff_type_id
    `;
    const result = await pool.query(query, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting from DB (USERS DELETE):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
