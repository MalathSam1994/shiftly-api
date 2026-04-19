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
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

router.get('/', async (req, res) => {
  try {
    const ownerUserId = Number(req.query.owner_user_id ?? req.query.ownerUserId);
    const shiftAssignmentId = Number(
      req.query.shift_assignment_id ?? req.query.shiftAssignmentId
    );

    if (!Number.isFinite(ownerUserId) || !Number.isFinite(shiftAssignmentId)) {
      return res.status(400).json({
        error: 'owner_user_id and shift_assignment_id are required integers.',
      });
    }

    const sql = `
      SELECT *
      FROM shiftly_api.fn_dropdown_offer_target_users($1, $2)
    `;
    const params = [ownerUserId, shiftAssignmentId];

    console.log(
      `[${req.rid}] DROPDOWN OFFER TARGET USERS sql=${sql.replace(/\s+/g, ' ').trim()}`
    );
    console.log(
      `[${req.rid}] DROPDOWN OFFER TARGET USERS params=${JSON.stringify(params)}`
    );

    const result = await queryWithTimeout(sql, params, 20000);
    res.json(result.rows);
  } catch (err) {
    console.error(
      `[${req.rid}] Error querying DB (DROPDOWN OFFER TARGET USERS):`,
      err
    );
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;