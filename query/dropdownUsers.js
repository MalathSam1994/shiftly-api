const express = require('express');
const pool = require('../db');
const router = express.Router();

function parseOptionalInt(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

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
 const staffTypeId = parseOptionalInt(req.query.staff_type_id);
 const divisionId = parseOptionalInt(req.query.division_id);

 const templateId = parseOptionalInt(req.query.template_id);
 const dayOfWeek = parseOptionalInt(req.query.day_of_week);
 const weekOfCycle = parseOptionalInt(req.query.week_of_cycle);
 const shiftTypeId = parseOptionalInt(req.query.shift_type_id);
 const excludeEntryId = parseOptionalInt(req.query.exclude_entry_id);

 const shiftPeriodId = parseOptionalInt(req.query.shift_period_id);
 const shiftDateRaw = req.query.shift_date;
 const shiftDate = shiftDateRaw == null || `${shiftDateRaw}`.trim() === ''
   ? null
   : `${shiftDateRaw}`.trim();

 if (!Number.isFinite(departmentId)) {
 return res.status(400).json({ error: 'department_id is required and must be an integer.' });
 }

 try {
 let sql;
 let params;

 const isTemplateMode =
   templateId != null || dayOfWeek != null || weekOfCycle != null || excludeEntryId != null;

 const isPeriodMode =
   shiftPeriodId != null || shiftDate != null;

 if (isTemplateMode) {
   if (templateId == null || dayOfWeek == null || weekOfCycle == null) {
     return res.status(400).json({
       error: 'template mode requires template_id, day_of_week, and week_of_cycle.',
     });
   }

   sql = `
     SELECT department_id, id, empno, user_name, user_desc, role_id, staff_type_id
     FROM shiftly_api.fn_dropdown_template_users($1, $2, $3, $4, $5, $6, $7, $8)
   `;
   params = [
     departmentId,
     staffTypeId,
     divisionId,
     templateId,
     dayOfWeek,
     weekOfCycle,
     shiftTypeId,
     excludeEntryId,
   ];
 } else if (isPeriodMode) {
   if (shiftPeriodId == null || !shiftDate) {
     return res.status(400).json({
       error: 'period mode requires shift_period_id and shift_date.',
     });
   }

   sql = `
     SELECT department_id, id, empno, user_name, user_desc, role_id, staff_type_id
     FROM shiftly_api.fn_dropdown_period_users($1, $2, $3, $4, $5::date, $6, $7)
   `;
   params = [
     departmentId,
     staffTypeId,
     divisionId,
     shiftPeriodId,
     shiftDate,
     shiftTypeId,
     parseOptionalInt(req.query.exclude_assignment_id),
   ];
 } else {
   sql = staffTypeId == null
   ? `
   SELECT department_id, id, empno, user_name, user_desc, role_id, staff_type_id
   FROM shiftly_schema.v_dropdown_dep_users
   WHERE department_id = $1
   ORDER BY user_name, empno
   `
   : `
   SELECT department_id, id, empno, user_name, user_desc, role_id, staff_type_id
   FROM shiftly_schema.v_dropdown_dep_users
   WHERE department_id = $1
   AND staff_type_id = $2
   ORDER BY user_name, empno
   `;

   params = staffTypeId == null ? [departmentId] : [departmentId, staffTypeId];
 }
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
