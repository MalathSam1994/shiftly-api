const express = require('express');
const pool = require('../db');

const router = express.Router();

function parseOptionalInt(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

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

// GET /dropdown/search-colleague-users?base_user_id=..&from=YYYY-MM-DD&to=YYYY-MM-DD[&division_id=..&department_id=..&shift_type_id=..]
router.get('/', async (req, res) => {
  const baseUserId = parseOptionalInt(req.query.base_user_id);
  const from = req.query.from ? String(req.query.from).trim() : '';
  const to = req.query.to ? String(req.query.to).trim() : '';
  const divisionId = parseOptionalInt(req.query.division_id);
  const departmentId = parseOptionalInt(req.query.department_id);
  const shiftTypeId = parseOptionalInt(req.query.shift_type_id);

  if (baseUserId == null || !from || !to) {
    return res.status(400).json({
      error:
        'base_user_id, from, and to are required. Example: /dropdown/search-colleague-users?base_user_id=2&from=2026-04-01&to=2026-05-01',
    });
  }

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
        must_change_password
      FROM shiftly_api.fn_dropdown_search_colleague_users($1, $2::date, $3::date, $4, $5, $6)
    `;

    const params = [
      baseUserId,
      from,
      to,
      divisionId,
      departmentId,
      shiftTypeId,
    ];

    console.log(
      `[${req.rid}] DROPDOWN SEARCH COLLEAGUE USERS sql=${sql.replace(/\s+/g, ' ').trim()}`
    );
    console.log(
      `[${req.rid}] DROPDOWN SEARCH COLLEAGUE USERS params=${JSON.stringify(params)}`
    );

    const result = await queryWithTimeout(sql, params, 20000);
    res.json(result.rows);
  } catch (err) {
    console.error(
      `[${req.rid}] Error querying DB (DROPDOWN SEARCH COLLEAGUE USERS):`,
      err
    );
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;