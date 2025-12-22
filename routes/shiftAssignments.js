// routes/shiftAssignments.js
const createCrudRouter = require('../createCrudRouter');

const shiftAssignmentsConfig = {
  table: 'shiftly_schema.shift_assignments',
  idColumn: 'id',
  columns: [
    'shift_period_id',
    'shift_date',
	'division_id',
    'department_id',
    'user_id',
    'staff_type_id',
    'shift_type_id',
    'source_type',
    'status',
    'status_comment',
	 'is_absence',
     'absence_type',
    'created_at',
    'updated_at',
	'staff_shift_rule_id',
    'required_staff_snapshot',
  ],
  
  
  
    // GET /shift-assignments?shift_period_id=123&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&limit=...&offset=...
  listHandler: async (req, res, { pool, config, allColumns }) => {
    const qp = req.query || {};

    const rawPeriod = qp.shift_period_id ?? qp.shiftPeriodId;
    const shiftPeriodId = rawPeriod != null ? Number(rawPeriod) : null;

    const startDate = (qp.start_date ?? qp.startDate ?? '').toString().trim();
    const endDate = (qp.end_date ?? qp.endDate ?? '').toString().trim();

    const limit = qp.limit != null ? Number(qp.limit) : null;
    const offset = qp.offset != null ? Number(qp.offset) : null;

    const where = [];
    const params = [];
    let i = 1;

    if (shiftPeriodId && Number.isFinite(shiftPeriodId)) {
      params.push(shiftPeriodId);
      where.push(`shift_period_id = $${i++}`);
    }
    if (startDate) {
      params.push(startDate);
      where.push(`shift_date >= $${i++}`);
    }
    if (endDate) {
      params.push(endDate);
      where.push(`shift_date <= $${i++}`);
    }

    let sql = `
      SELECT ${allColumns.join(', ')}
      FROM ${config.table}
    `;
    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ` ORDER BY shift_date ASC, id ASC`;

    if (limit && Number.isFinite(limit)) {
      params.push(limit);
      sql += ` LIMIT $${i++}`;
    }
    if (offset && Number.isFinite(offset)) {
      params.push(offset);
      sql += ` OFFSET $${i++}`;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows);
  },
  
  
};

module.exports = createCrudRouter(shiftAssignmentsConfig);
