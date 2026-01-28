// routes/shiftAssignments.js
const createCrudRouter = require('../createCrudRouter');
const pool = require('../db');

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

const router = createCrudRouter(shiftAssignmentsConfig);

/**
 * POST /shift-assignments/create-smart
 *
 * Thin API: delegate all business logic to PostgreSQL:
 * - resolve staff_type_id from user
 * - match staff_shift_rule_id + required_staff_snapshot
 * - insert and return created assignment row
 */
router.post('/create-smart', async (req, res) => {
  try {
    const b = req.body || {};

    const shiftPeriodId = Number(b.shiftPeriodId ?? b.shift_period_id);
    const divisionId = b.divisionId ?? b.division_id ?? null;
    const departmentId = Number(b.departmentId ?? b.department_id);
    const userId = Number(b.userId ?? b.user_id);
    const shiftTypeId = Number(b.shiftTypeId ?? b.shift_type_id);
    const shiftDate = (b.shiftDate ?? b.shift_date ?? '').toString().trim(); // YYYY-MM-DD
    const status = (b.status ?? '').toString().trim();
    const statusComment = (b.statusComment ?? b.status_comment ?? null);
    const sourceType = (b.sourceType ?? b.source_type ?? 'MANUAL').toString().trim();
    const isAbsenceRaw = (b.isAbsence ?? b.is_absence ?? null);
    const isAbsence = isAbsenceRaw != null ? Number(isAbsenceRaw) : 2; // 1=yes, 2=no
    const absenceType = (b.absenceType ?? b.absence_type ?? null);


    if (!Number.isFinite(shiftPeriodId) || !Number.isFinite(departmentId) || !Number.isFinite(userId) || !Number.isFinite(shiftTypeId)) {
      return res.status(400).json({ error: 'Invalid numeric fields.' });
    }
    if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      return res.status(400).json({ error: 'Invalid shiftDate (expected YYYY-MM-DD).' });
    }
    if (!status) {
      return res.status(400).json({ error: 'status is required.' });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM shiftly_schema.create_shift_assignment(
        $1,              -- shift_period_id
        $2::int,         -- division_id
        $3,              -- department_id
        $4,              -- user_id
        $5,              -- shift_type_id
        $6::date,        -- shift_date
        $7,              -- status
        $8,              -- status_comment
        $9, -- source_type
        $10::int, -- is_absence
        $11 -- absence_type
      )
      `,
      [
        shiftPeriodId,
        divisionId,
        departmentId,
        userId,
        shiftTypeId,
        shiftDate,
        status,
        statusComment,
        sourceType,
        Number.isFinite(isAbsence) ? isAbsence : 2,
        absenceType,
      ],
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(500).json({ error: 'No row returned from create_shift_assignment.' });
    }

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating assignment (create-smart):', err);
    const isBusiness = err && err.code === 'P0001';
    return res.status(isBusiness ? 400 : 500).json({
      error: isBusiness ? 'Business rule violation' : 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

module.exports = router;
