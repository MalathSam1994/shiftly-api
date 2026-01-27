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

// GET /dropdown/departments
router.get('/', async (req, res) => {
 try {
 const sql = `
 SELECT id, department_desc
 FROM shiftly_schema.v_dropdown_div_departments
 ORDER BY department_desc
 `;
 const result = await queryWithTimeout(sql, [], 20000);
 res.json(result.rows);
 } catch (err) {
 console.error('Error querying DB (DROPDOWN DEPARTMENTS):', err);
 res.status(500).json({ error: 'Database error' });
 }
});

module.exports = router;