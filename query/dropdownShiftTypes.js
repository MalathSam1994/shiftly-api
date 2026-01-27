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

// GET /dropdown/shift-types
router.get('/', async (req, res) => {
 try {
 const sql = `
 SELECT id, shift_label, shift_code, start_time, end_time, duration_hours, day_type, notes
 FROM shiftly_schema.v_dropdown_shift_types
 ORDER BY shift_label, shift_code
 `;
 const result = await queryWithTimeout(sql, [], 20000);
 res.json(result.rows);
 } catch (err) {
 console.error('Error querying DB (DROPDOWN SHIFT TYPES):', err);
 res.status(500).json({ error: 'Database error' });
 }
});

module.exports = router;