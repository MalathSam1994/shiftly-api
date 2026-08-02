
const express = require('express');
const pool = require('../db');
const { actorUserId } = require('../utils/shiftPeriodScope');

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

// GET /dropdown/template-period-divisions
router.get('/', async (req, res) => {
  try {
    const userId = actorUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const sql = `
      SELECT DISTINCT d.id, d.division_desc, d.is_active
      FROM shiftly_schema.v_dropdown_template_period_div d
      JOIN shiftly_schema.division_departments dd
        ON dd.division_id = d.id
       AND dd.is_active = true
      JOIN shiftly_schema.departments dep
        ON dep.id = dd.department_id
       AND dep.is_active = true
      WHERE d.is_active = true
        AND (
          EXISTS (
            SELECT 1
            FROM shiftly_schema.users u
            JOIN shiftly_schema.staff_types st ON st.id = u.staff_type_id
            WHERE u.id = $1
              AND u.is_active = true
              AND st.is_active = true
              AND lower(trim(st.staff_type_name)) = 'admin'
          )
          OR EXISTS (
            SELECT 1
            FROM shiftly_schema.user_managers um
            WHERE um.manager_user_id = $1
              AND um.division_id = dd.division_id
              AND um.department_id = dd.department_id
              AND um.is_active = true
          )
          OR (
            EXISTS (
              SELECT 1
              FROM shiftly_schema.user_divisions udv
              WHERE udv.user_id = $1
                AND udv.division_id = dd.division_id
                AND udv.is_active = true
            )
            AND EXISTS (
              SELECT 1
              FROM shiftly_schema.user_department udp
              WHERE udp.user_id = $1
                AND udp.department_id = dd.department_id
                AND udp.is_active = true
            )
          )
        )
      ORDER BY d.division_desc
    `;

    console.log(
      `[${req.rid}] DROPDOWN TEMPLATE/PERIOD DIVISIONS sql=${sql.replace(/\s+/g, ' ').trim()}`
    );

    const result = await queryWithTimeout(sql, [userId], 20000);
    res.json(result.rows);
  } catch (err) {
    console.error(
      `[${req.rid}] Error querying DB (DROPDOWN TEMPLATE/PERIOD DIVISIONS):`,
      err
    );
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
