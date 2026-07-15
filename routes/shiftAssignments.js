// routes/shiftAssignments.js
const express = require('express');
const createCrudRouter = require('../createCrudRouter');
const pool = require('../db');

const EDIT_APPROVED_ASSIGNMENTS_PERMISSION =
  'action:shift_periods:edit_approved_assignments';

function parseNullableInt(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

async function validateAssignmentPeriodScope({
  shiftPeriodId,
  divisionId,
  departmentId,
}) {
  const periodId = parseNullableInt(shiftPeriodId);
  const divId = parseNullableInt(divisionId);
  const deptId = parseNullableInt(departmentId);

  if (periodId == null || divId == null || deptId == null) {
    return 'shift_period_id, division_id, and department_id are required.';
  }

  const result = await pool.query(
    `
    SELECT id
    FROM shiftly_schema.shift_periods
    WHERE id = $1
      AND division_id = $2
      AND department_id = $3
    LIMIT 1
    `,
    [periodId, divId, deptId],
  );

  if (!result.rows.length) {
    return 'The selected Shift Period does not belong to this division and department.';
  }

  return null;
}

function parseNullableTime(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const s = `${value}`.trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!match) return undefined;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const sec = match[3] == null ? 0 : Number(match[3]);
  if (h < 0 || h > 23 || m < 0 || m > 59 || sec < 0 || sec > 59) {
    return undefined;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function ensureApprovedPeriodAssignmentEditAllowed({
  req,
  shiftPeriodId,
  assignmentId,
}) {
  let result;
  if (assignmentId != null) {
    result = await pool.query(
      `
      SELECT sp.status
      FROM shiftly_schema.shift_assignments sa
      JOIN shiftly_schema.shift_periods sp ON sp.id = sa.shift_period_id
      WHERE sa.id = $1
      LIMIT 1
      `,
      [assignmentId],
    );
  } else {
    result = await pool.query(
      `
      SELECT status
      FROM shiftly_schema.shift_periods
      WHERE id = $1
      LIMIT 1
      `,
      [shiftPeriodId],
    );
  }

  if (!result.rows.length) return 'Shift Period or assignment not found.';
  const status = (result.rows[0].status || '').toString().trim().toUpperCase();
  if (status !== 'APPROVED') return null;

  const userId = Number(req.user?.sub ?? req.user?.id);
  if (!userId) return 'Unauthorized.';

  const permissionResult = await pool.query(
    `SELECT shiftly_api.fn_user_has_permission($1, $2) AS ok`,
    [userId, EDIT_APPROVED_ASSIGNMENTS_PERMISSION],
  );

  if (!permissionResult.rows?.[0]?.ok) {
    return 'Cannot edit assignments for an APPROVED period.';
  }

  return null;
}

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
    'start_time',
    'end_time',
  ],

  createHandler: async (req, res) => {
    try {
      const b = req.body || {};
      const shiftPeriodId = Number(b.shift_period_id ?? b.shiftPeriodId ?? b.shift_periodId);
      const divisionId = b.division_id ?? b.divisionId ?? null;
      const departmentId = Number(b.department_id ?? b.departmentId);
      const userId = Number(b.user_id ?? b.userId);
      const shiftTypeId = Number(b.shift_type_id ?? b.shiftTypeId);
      const shiftDate = (b.shift_date ?? b.shiftDate ?? '').toString().trim();
      const status = (b.status ?? '').toString().trim();
      const statusComment = (b.status_comment ?? b.statusComment ?? null);
      const sourceType = (b.source_type ?? b.sourceType ?? 'MANUAL').toString().trim();
      const isAbsenceRaw = (b.is_absence ?? b.isAbsence ?? null);
      const isAbsence = isAbsenceRaw != null ? Number(isAbsenceRaw) : 2;
      const absenceType = (b.absence_type ?? b.absenceType ?? null);
      const startTime = parseNullableTime(b.start_time ?? b.startTime ?? null);
      const endTime = parseNullableTime(b.end_time ?? b.endTime ?? null);

      if (!Number.isFinite(shiftPeriodId) || !Number.isFinite(departmentId) || !Number.isFinite(userId) || !Number.isFinite(shiftTypeId)) {
        return res.status(400).json({ error: 'Invalid numeric fields.' });
      }
      if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
        return res.status(400).json({ error: 'Invalid shiftDate (expected YYYY-MM-DD).' });
      }
      if (!status) {
        return res.status(400).json({ error: 'status is required.' });
      }
      if (startTime === undefined || endTime === undefined) {
        return res.status(400).json({ error: 'Invalid time format (expected HH:MM or HH:MM:SS).' });
      }

      const scopeError = await validateAssignmentPeriodScope({
        shiftPeriodId,
        divisionId,
        departmentId,
      });
      if (scopeError) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: scopeError,
          code: 'P0001',
        });
      }

      const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
        req,
        shiftPeriodId,
      });
      if (approvedEditError) {
        return res.status(403).json({
          error: 'Forbidden',
          details: approvedEditError,
          permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION,
        });
      }

      const result = await pool.query(
        `
        SELECT
          r.id,
          r.shift_period_id,
          to_char(r.shift_date, 'YYYY-MM-DD') AS shift_date,
          r.division_id,
          r.department_id,
          r.user_id,
          r.staff_type_id,
          r.shift_type_id,
          r.source_type,
          r.status,
          r.status_comment,
          r.is_absence,
          r.absence_type,
          r.created_at,
          r.updated_at,
          r.staff_shift_rule_id,
          r.required_staff_snapshot,
          to_char(r.start_time, 'HH24:MI:SS') AS start_time,
          to_char(r.end_time, 'HH24:MI:SS') AS end_time
        FROM shiftly_api.create_shift_assignment(
          $1,
          $2::int,
          $3,
          $4,
          $5,
          $6::date,
          $7,
          $8,
          $9,
          $10::int,
          $11,
          $12::time,
          $13::time
        ) AS r
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
          startTime,
          endTime,
        ],
      );

      if (!result.rows || result.rows.length === 0) {
        return res.status(500).json({ error: 'No row returned from create_shift_assignment.' });
      }

      return res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('Error creating assignment (DB function):', err);
      const isBusiness = err && err.code === 'P0001';
      return res.status(isBusiness ? 400 : 500).json({
        error: isBusiness ? 'Business rule violation' : 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    }
  },
  
  
  
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
      SELECT
        id,
        shift_period_id,
        to_char(shift_date, 'YYYY-MM-DD') AS shift_date,
        division_id,
        department_id,
        user_id,
        staff_type_id,
        shift_type_id,
        source_type,
        status,
        status_comment,
        is_absence,
        absence_type,
        created_at,
        updated_at,
        staff_shift_rule_id,
        required_staff_snapshot,
        to_char(start_time, 'HH24:MI:SS') AS start_time,
        to_char(end_time, 'HH24:MI:SS') AS end_time,
        counts.assigned_count,
        GREATEST(COALESCE(required_staff_snapshot, 0) - counts.assigned_count, 0)::int AS available_count,
        (counts.assigned_count > COALESCE(required_staff_snapshot, 0)) AS is_overridden
      FROM ${config.table} sa
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS assigned_count
        FROM shiftly_schema.shift_assignments x
        WHERE x.shift_period_id = sa.shift_period_id
          AND x.shift_date = sa.shift_date
          AND COALESCE(x.division_id, 0) = COALESCE(sa.division_id, 0)
          AND x.department_id = sa.department_id
          AND COALESCE(x.staff_type_id, 0) = COALESCE(sa.staff_type_id, 0)
          AND x.shift_type_id = sa.shift_type_id
          AND COALESCE(x.is_absence, 2) <> 1
          AND x.status <> 'CANCELLED'
      ) counts ON TRUE
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
  

  // ✅ Single source of truth for EDIT: delegate edit logic to PostgreSQL
  // PUT /shift-assignments/:id
  updateHandler: async (req, res, { pool }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const b = req.body || {};
      const shiftPeriodId = Number(b.shift_period_id ?? b.shiftPeriodId ?? b.shift_periodId);
      const divisionId = (b.division_id ?? b.divisionId ?? null);
      const departmentId = Number(b.department_id ?? b.departmentId);
      const userId = Number(b.user_id ?? b.userId);
      const shiftTypeId = Number(b.shift_type_id ?? b.shiftTypeId);
      const shiftDate = (b.shift_date ?? b.shiftDate ?? '').toString().trim(); // YYYY-MM-DD
      const status = (b.status ?? '').toString().trim();
      const statusComment = (b.status_comment ?? b.statusComment ?? null);
      const isAbsenceRaw = (b.is_absence ?? b.isAbsence ?? null);
      const isAbsence = isAbsenceRaw != null ? Number(isAbsenceRaw) : 2; // 1=yes, 2=no
      const absenceType = (b.absence_type ?? b.absenceType ?? null);
      const startTime = parseNullableTime(b.start_time ?? b.startTime ?? null);
      const endTime = parseNullableTime(b.end_time ?? b.endTime ?? null);

      if (
        !Number.isFinite(shiftPeriodId) ||
        !Number.isFinite(departmentId) ||
        !Number.isFinite(userId) ||
        !Number.isFinite(shiftTypeId)
      ) {
        return res.status(400).json({ error: 'Invalid numeric fields.' });
      }
      if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
        return res.status(400).json({ error: 'Invalid shiftDate (expected YYYY-MM-DD).' });
      }
      if (!status) {
        return res.status(400).json({ error: 'status is required.' });
      }
      if (startTime === undefined || endTime === undefined) {
        return res.status(400).json({ error: 'Invalid time format (expected HH:MM or HH:MM:SS).' });
      }

      const scopeError = await validateAssignmentPeriodScope({
        shiftPeriodId,
        divisionId,
        departmentId,
      });
      if (scopeError) {
        return res.status(400).json({
          error: 'Business rule violation',
          details: scopeError,
          code: 'P0001',
        });
      }

      const currentPeriodEditError = await ensureApprovedPeriodAssignmentEditAllowed({
        req,
        assignmentId: id,
      });
      const targetPeriodEditError = await ensureApprovedPeriodAssignmentEditAllowed({
        req,
        shiftPeriodId,
      });
      const approvedEditError = currentPeriodEditError || targetPeriodEditError;
      if (approvedEditError) {
        return res.status(403).json({
          error: 'Forbidden',
          details: approvedEditError,
          permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION,
        });
      }

      const result = await pool.query(
        `
        SELECT
          r.id,
          r.shift_period_id,
          to_char(r.shift_date, 'YYYY-MM-DD') AS shift_date,
          r.division_id,
          r.department_id,
          r.user_id,
          r.staff_type_id,
          r.shift_type_id,
          r.source_type,
          r.status,
          r.status_comment,
          r.is_absence,
          r.absence_type,
          r.created_at,
          r.updated_at,
          r.staff_shift_rule_id,
          r.required_staff_snapshot,
          to_char(r.start_time, 'HH24:MI:SS') AS start_time,
          to_char(r.end_time, 'HH24:MI:SS') AS end_time
        FROM shiftly_api.update_shift_assignment(
          $1,
          $2,
          $3::int,
          $4,
          $5,
          $6,
          $7::date,
          $8,
          $9,
          $10::int,
          $11,
          $12::time,
          $13::time
        ) AS r
        `,
        [
          id,
          shiftPeriodId,
          divisionId,
          departmentId,
          userId,
          shiftTypeId,
          shiftDate,
          status,
          statusComment,
          Number.isFinite(isAbsence) ? isAbsence : 2,
          absenceType,
          startTime,
          endTime,
        ],
      );

      if (!result.rows || result.rows.length === 0) {
        return res.status(500).json({ error: 'No row returned from update_shift_assignment.' });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      console.error('Error updating assignment (DB function):', err);
      const isBusiness = err && err.code === 'P0001';
      return res.status(isBusiness ? 400 : 500).json({
        error: isBusiness ? 'Business rule violation' : 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    }
  },
   

};

const router = express.Router();


/**
 * GET /shift-assignments/mobile-day-details?user_id=123&date=YYYY-MM-DD
 *
 * Centralized mobile payload:
 * - backend decides tap_action
 * - backend decides which assignments DayDetails should show
 * - backend returns pending requests + effective user absence type
 */
router.get('/mobile-day-details', async (req, res) => {
  try {
    const rawUserId = req.query.user_id ?? req.query.userId;
    const rawDate = (req.query.date ?? '').toString().trim();

    const userId = Number(rawUserId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user_id.' });
    }
    if (!rawDate || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return res.status(400).json({ error: 'Invalid date (expected YYYY-MM-DD).' });
    }

    const result = await pool.query(
      `
      SELECT shiftly_api.fn_mobile_day_details($1::int, $2::date) AS payload
      `,
      [userId, rawDate],
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: 'No payload returned.' });
    }

    return res.json(result.rows[0].payload);
  } catch (err) {
    console.error('Error loading mobile day details:', err);
    return res.status(500).json({
      error: 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});


// IMPORTANT:
// Mount CRUD routes only AFTER custom static routes,
// otherwise "/mobile-day-details" may be captured by "/:id".
router.use('/', createCrudRouter(shiftAssignmentsConfig));

/**
 * DELETE /shift-assignments/:id/hard
 *
 * ✅ Hard delete an assignment row (real remove).
 * Guards:
 * - period must NOT be APPROVED (editing locked)
 *
 * Returns:
 * - 200 { deleted: { ...row } }
 * - 404 if not found
 */
router.delete('/:id/hard', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    // Load period status for this assignment
    const meta = await pool.query(
      `
      SELECT sa.id, sa.shift_period_id, sp.status AS period_status
      FROM shiftly_schema.shift_assignments sa
      JOIN shiftly_schema.shift_periods sp ON sp.id = sa.shift_period_id
      WHERE sa.id = $1
      `,
      [id],
    );
    if (!meta.rows || meta.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
      req,
      assignmentId: id,
    });
    if (approvedEditError) {
      return res.status(403).json({
        error: 'Forbidden',
        details: approvedEditError,
        permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION,
      });
    }

    const result = await pool.query(
      `
      DELETE FROM shiftly_schema.shift_assignments
      WHERE id = $1
      RETURNING
        id,
        shift_period_id,
        to_char(shift_date, 'YYYY-MM-DD') AS shift_date,
        division_id,
        department_id,
        user_id,
        staff_type_id,
        shift_type_id,
        source_type,
        status,
        status_comment,
        created_at,
        updated_at,
        staff_shift_rule_id,
        required_staff_snapshot,
        is_absence,
        absence_type,
        to_char(start_time, 'HH24:MI:SS') AS start_time,
        to_char(end_time, 'HH24:MI:SS') AS end_time
      `,
      [id],
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('Error hard deleting assignment:', err);
    const isBusiness = err && err.code === 'P0001';
    return res.status(isBusiness ? 400 : 500).json({
      error: isBusiness ? 'Business rule violation' : 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});



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
    const startTime = parseNullableTime(b.startTime ?? b.start_time ?? null);
    const endTime = parseNullableTime(b.endTime ?? b.end_time ?? null);


    if (!Number.isFinite(shiftPeriodId) || !Number.isFinite(departmentId) || !Number.isFinite(userId) || !Number.isFinite(shiftTypeId)) {
      return res.status(400).json({ error: 'Invalid numeric fields.' });
    }
    if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      return res.status(400).json({ error: 'Invalid shiftDate (expected YYYY-MM-DD).' });
    }
    if (!status) {
      return res.status(400).json({ error: 'status is required.' });
    }
    if (startTime === undefined || endTime === undefined) {
      return res.status(400).json({ error: 'Invalid time format (expected HH:MM or HH:MM:SS).' });
    }

    const scopeError = await validateAssignmentPeriodScope({
      shiftPeriodId,
      divisionId,
      departmentId,
    });
    if (scopeError) {
      return res.status(400).json({
        error: 'Business rule violation',
        details: scopeError,
        code: 'P0001',
      });
    }

    const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
      req,
      shiftPeriodId,
    });
    if (approvedEditError) {
      return res.status(403).json({
        error: 'Forbidden',
        details: approvedEditError,
        permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION,
      });
    }

    const result = await pool.query(
      `
      SELECT
        r.id,
        r.shift_period_id,
        to_char(r.shift_date, 'YYYY-MM-DD') AS shift_date,
        r.department_id,
        r.user_id,
        r.staff_type_id,
        r.shift_type_id,
        r.source_type,
        r.status,
        r.status_comment,
        r.created_at,
        r.updated_at,
        r.staff_shift_rule_id,
        r.required_staff_snapshot,
        r.is_absence,
        r.absence_type,
        r.division_id,
        to_char(r.start_time, 'HH24:MI:SS') AS start_time,
        to_char(r.end_time, 'HH24:MI:SS') AS end_time
      FROM shiftly_api.create_shift_assignment(
        $1,
        $2::int,
        $3,
        $4,
        $5,
        $6::date,
        $7,
        $8,
        $9,
        $10::int,
        $11,
        $12::time,
        $13::time
      ) AS r
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
        startTime,
        endTime,
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
