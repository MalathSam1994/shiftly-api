const express = require('express');
const pool = require('../db');

const router = express.Router();

async function queryWithTimeout(sql, params, timeoutMs = 20000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// GET /dropdown/user-manager-managers
// Dedicated endpoint for Manager picker on User Managers screen only.
// Backed by a separate DB view so it can diverge from the User picker later.
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT
        id,
        empno,
        user_name,
        user_desc,
        role_id,
        staff_type_id,
        email,
        COALESCE(must_change_password, false) AS must_change_password
      FROM shiftly_schema.v_dropdown_user_manager_managers
      ORDER BY user_name, empno NULLS LAST
    `;

    console.log(
      `[${req.rid}] DROPDOWN USER MANAGER MANAGERS sql=${sql.replace(/\s+/g, ' ').trim()}`
    );

    const result = await queryWithTimeout(sql, [], 20000);
    res.json(result.rows);
  } catch (err) {
    console.error(
      `[${req.rid}] Error querying DB (DROPDOWN USER MANAGER MANAGERS):`,
      err
    );
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;