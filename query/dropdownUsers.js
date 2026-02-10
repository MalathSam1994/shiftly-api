const express = require('express');
const pool = require('../db');
const router = express.Router();

// Run a single query with a per-request statement_timeout that does NOT leak to pooled sessions.
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

// GET /dropdown/users?department_id=..[&staff_type_id=..]
router.get('/', async (req, res) => {
 const departmentId = parseInt(req.query.department_id, 10);
 const staffTypeIdRaw = req.query.staff_type_id;
 const staffTypeId = staffTypeIdRaw == null ? null : parseInt(staffTypeIdRaw, 10);

 if (!Number.isFinite(departmentId)) {
 return res.status(400).json({ error: 'department_id is required and must be an integer.' });
 }

 try {
 const sql = staffTypeId == null
 ? `
 SELECT id, empno, user_name, user_desc, role_id, staff_type_id
 FROM shiftly_schema.v_dropdown_dep_users
 WHERE department_id = $1
 ORDER BY user_name, empno
 `
 : `
 SELECT id, empno, user_name, user_desc, role_id, staff_type_id
 FROM shiftly_schema.v_dropdown_dep_users
 WHERE department_id = $1
 AND staff_type_id = $2
 ORDER BY user_name, empno
 `;

 const params = staffTypeId == null ? [departmentId] : [departmentId, staffTypeId];
 console.log(`[${req.rid}] DROPDOWN USERS sql=${sql.replace(/\s+/g, ' ').trim()}`);
 console.log(`[${req.rid}] DROPDOWN USERS params=${JSON.stringify(params)}`);
 const result = await queryWithTimeout(sql, params, 20000);
 res.json(result.rows);
 } catch (err) {
 console.error(`[${req.rid}] Error querying DB (DROPDOWN USERS):`, err);
 // pg error fields (when present): code, detail, hint, position, where, schema, table, column, constraint
 console.error(`[${req.rid}] pg.err.props=`, {
 message: err?.message,
 code: err?.code,
 detail: err?.detail,
 hint: err?.hint,
 position: err?.position,
 where: err?.where,
 schema: err?.schema,
 table: err?.table,
 column: err?.column,
 constraint: err?.constraint,
 stack: err?.stack,
 });

 // Optional: return DB error details only when explicitly enabled
 if (process.env.DEBUG_DB_ERRORS === '1') {
 return res.status(500).json({
 error: 'Database error',
 code: err?.code ?? null,
 message: err?.message ?? null,
 detail: err?.detail ?? null,
 hint: err?.hint ?? null,
 });
 }

 res.status(500).json({ error: 'Database error' });
 
 }
});

module.exports = router;
