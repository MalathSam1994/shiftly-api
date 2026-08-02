// routes/shiftAssignments.js
const express = require('express');
const createCrudRouter = require('../createCrudRouter');
const pool = require('../db');
const { sendApiError, sendInternalError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');
const {
  actorUserId,
  requireDivisionDepartmentAccess,
  scopedPeriodsWhere,
} = require('../utils/shiftPeriodScope');

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

async function loadAssignmentScope(assignmentId) {
  const result = await pool.query(
    `
    SELECT
      sa.id,
      sa.shift_period_id,
      sa.division_id,
      sa.department_id,
      sa.status AS assignment_status,
      sp.status AS period_status
    FROM shiftly_schema.shift_assignments sa
    JOIN shiftly_schema.shift_periods sp
      ON sp.id = sa.shift_period_id
    WHERE sa.id = $1
    LIMIT 1
    `,
    [assignmentId],
  );

  return result.rows?.[0] ?? null;
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

function parseRequiredStaffCount(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    return undefined;
  }
  return parsed;
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
      const requiredStaffCount = parseRequiredStaffCount(
        b.assignment_required_staff_count ??
          b.assignmentRequiredStaffCount ??
          b.required_staff_count ??
          null,
      );

      if (!Number.isFinite(shiftPeriodId) || !Number.isFinite(departmentId) || !Number.isFinite(userId) || !Number.isFinite(shiftTypeId)) {
        return sendApiError(req, res, {
          status: 400,
          error: 'Required numeric fields are invalid.',
          code: 'INVALID_REQUEST',
        });
      }
      if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
        return sendApiError(req, res, {
          status: 400,
          error: 'A valid shift date is required.',
          code: 'INVALID_REQUEST',
        });
      }
      if (!status) {
        return sendApiError(req, res, {
          status: 400,
          error: 'Status is required.',
          code: 'INVALID_REQUEST',
        });
      }
      if (startTime === undefined || endTime === undefined) {
        return sendApiError(req, res, {
          status: 400,
          error: 'Use a valid time format.',
          code: 'INVALID_REQUEST',
        });
      }
      if (requiredStaffCount === undefined) {
        return sendApiError(req, res, {
          status: 400,
          error: 'Required staff count must be a whole number between 1 and 1000.',
          code: 'INVALID_REQUEST',
        });
      }
      if (requiredStaffCount != null) {
        return sendApiError(req, res, {
          status: 400,
          error: 'Required staff count is edited at the shift group level.',
          details: 'Use the capacity group endpoint instead of sending a per-assignment required staff count.',
          code: 'INVALID_REQUEST',
        });
      }

      const scopeError = await validateAssignmentPeriodScope({
        shiftPeriodId,
        divisionId,
        departmentId,
      });
      if (scopeError) {
        return sendApiError(req, res, {
          status: 422,
          error: 'The request could not be completed.',
          details: scopeError,
          code: 'DEPARTMENT_DIVISION_MISMATCH',
        });
      }

      const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
        req,
        shiftPeriodId,
      });
      if (approvedEditError) {
        return sendApiError(req, res, {
          status: 403,
          error: 'You do not have permission to perform this action.',
          details: approvedEditError,
          code: 'PERMISSION_DENIED',
          extra: { permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION },
        });
      }
      const allowed = await requireDivisionDepartmentAccess(req, res, {
        divisionId,
        departmentId,
      });
      if (!allowed) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
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
          r.assignment_required_staff_count,
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
        await client.query('ROLLBACK');
        return sendInternalError(
          req,
          res,
          new Error('No row returned from create_shift_assignment.'),
          'create_shift_assignment returned no row',
        );
      }

        const row = result.rows[0];
        await client.query('COMMIT');
        return res.status(201).json(row);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'CREATE',
        label: 'Error creating assignment (DB function)',
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
      where.push(`sa.shift_period_id = $${i++}`);
    }
    if (startDate) {
      params.push(startDate);
       where.push(`sa.shift_date >= $${i++}::date`);
    }
    if (endDate) {
      params.push(endDate);
      where.push(`sa.shift_date <= $${i++}::date`);
    }

    let sql = `
      SELECT
        sa.id,
        sa.shift_period_id,
        to_char(sa.shift_date, 'YYYY-MM-DD') AS shift_date,
        sa.division_id,
        sa.department_id,
        sa.user_id,
        sa.staff_type_id,
        sa.shift_type_id,
        sa.source_type,
        sa.status,
        sa.status_comment,
        sa.is_absence,
        sa.absence_type,
        sa.created_at,
        sa.updated_at,
        sa.staff_shift_rule_id,
        sa.required_staff_snapshot,
        g.id AS capacity_group_id,
       COALESCE(
         g.required_staff_count,
         sa.assignment_required_staff_count,
         sa.required_staff_snapshot,
         0
       )::int AS assignment_required_staff_count,
        g.pending_required_staff_count,
        g.capacity_status,
        to_char(sa.start_time, 'HH24:MI:SS') AS start_time,
        to_char(sa.end_time, 'HH24:MI:SS') AS end_time,
        counts.assigned_count,
        GREATEST(
          COALESCE(
            g.required_staff_count,
            sa.assignment_required_staff_count,
            sa.required_staff_snapshot,
            0
          ) - counts.assigned_count,
          0
        )::int AS available_count,
        (
          counts.assigned_count >
          COALESCE(
            g.required_staff_count,
            sa.assignment_required_staff_count,
            sa.required_staff_snapshot,
            0
          )
        ) AS is_overridden
      FROM ${config.table} sa
      LEFT JOIN shiftly_schema.shift_assignment_capacity_groups g
        ON g.shift_period_id = sa.shift_period_id
       AND g.shift_date = sa.shift_date
       AND g.division_id = sa.division_id
       AND g.department_id = sa.department_id
       AND g.staff_type_id = sa.staff_type_id
       AND g.shift_type_id = sa.shift_type_id
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
          AND UPPER(COALESCE(x.status, '')) <> 'CANCELLED'
      ) counts ON TRUE
    `;
    const userId = actorUserId(req);
    if (!userId) {
      return sendApiError(req, res, {
        status: 401,
        error: 'Please sign in to continue.',
        code: 'AUTH_REQUIRED',
      });
    }
    const scope = scopedPeriodsWhere('sa', i);
    params.push(userId);
    where.push(scope.sql);
    i++;
    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
     sql += ` ORDER BY sa.shift_date ASC, sa.id ASC`;

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
      const requiredStaffCount = parseRequiredStaffCount(
        b.assignment_required_staff_count ??
          b.assignmentRequiredStaffCount ??
          b.required_staff_count ??
          null,
      );
      const approveAssignment =
        b.approve_assignment === true || b.approveAssignment === true;

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
      if (requiredStaffCount === undefined) {
        return res.status(400).json({
          error: 'Required staff count must be a whole number between 1 and 1000.',
          code: 'INVALID_REQUEST',
        });
      }
      if (requiredStaffCount != null) {
        return sendApiError(req, res, {
          status: 400,
          error: 'Required staff count is edited at the shift group level.',
          details: 'Use the capacity group endpoint instead of sending a per-assignment required staff count.',
          code: 'INVALID_REQUEST',
        });
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


      /*
       * Authorize access to the assignment's current scope before allowing it
       * to be moved or edited in another division/department.
       *
       * Without this check, a caller who knows an assignment ID could submit a
       * destination scope they are allowed to manage while the original
       * assignment belongs to a scope they are not allowed to manage.
       */
      const currentAssignment = await loadAssignmentScope(id);
      if (!currentAssignment) {
        return sendApiError(req, res, {
          status: 404,
          error: 'The requested record could not be found.',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      const currentScopeAllowed = await requireDivisionDepartmentAccess(
        req,
        res,
        {
          divisionId: currentAssignment.division_id,
          departmentId: currentAssignment.department_id,
        },
      );
      if (!currentScopeAllowed) return;





      
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
      const targetScopeAllowed = await requireDivisionDepartmentAccess(req, res, {
        divisionId,
        departmentId,
      });
 if (!targetScopeAllowed) return;

      const targetPeriod = await pool.query(
        `SELECT status FROM shiftly_schema.shift_periods WHERE id = $1 LIMIT 1`,
        [shiftPeriodId],
      );
      const targetPeriodApproved =
        (targetPeriod.rows?.[0]?.status || '').toString().trim().toUpperCase() === 'APPROVED';
      const effectiveStatus = targetPeriodApproved
        ? (approveAssignment ? 'APPROVED' : 'REQUESTED')
        : status;
      const effectiveStatusComment =
        targetPeriodApproved && !approveAssignment && !statusComment
          ? 'Edited after period approval; pending assignment approval.'
          : statusComment;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
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
          r.assignment_required_staff_count,
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
          effectiveStatus,
          effectiveStatusComment,
          Number.isFinite(isAbsence) ? isAbsence : 2,
          absenceType,
          startTime,
          endTime,
        ],
      );

      if (!result.rows || result.rows.length === 0) {
        await client.query('ROLLBACK');
        return sendInternalError(
          req,
          res,
          new Error('No row returned from update_shift_assignment.'),
          'update_shift_assignment returned no row',
        );
      }

        const row = result.rows[0];
        await client.query('COMMIT');
        return res.json(row);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'UPDATE',
        label: 'Error updating assignment (DB function)',
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
      return sendApiError(req, res, {
        status: 400,
        error: 'A valid user is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!rawDate || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A valid date is required.',
        code: 'INVALID_REQUEST',
      });
    }

    const result = await pool.query(
      `
      SELECT shiftly_api.fn_mobile_day_details($1::int, $2::date) AS payload
      `,
      [userId, rawDate],
    );

    if (!result.rows || result.rows.length === 0) {
      return sendApiError(req, res, {
        status: 404,
        error: 'No day details were found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }

    return res.json(result.rows[0].payload);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading mobile day details',
    });
  }
});

router.put('/capacity-groups', async (req, res) => {
  try {
    const b = req.body || {};
    const shiftPeriodId = Number(b.shift_period_id ?? b.shiftPeriodId);
    const divisionId = Number(b.division_id ?? b.divisionId);
    const departmentId = Number(b.department_id ?? b.departmentId);
    const staffTypeId = Number(b.staff_type_id ?? b.staffTypeId);
    const shiftTypeId = Number(b.shift_type_id ?? b.shiftTypeId);
    const shiftDate = (b.shift_date ?? b.shiftDate ?? '').toString().trim();
    const requiredStaffCount = parseRequiredStaffCount(
      b.required_staff_count ?? b.requiredStaffCount,
    );
    const approve = b.approve === true || b.approveCapacity === true;

    if (
      !Number.isFinite(shiftPeriodId) ||
      !Number.isFinite(divisionId) ||
      !Number.isFinite(departmentId) ||
      !Number.isFinite(staffTypeId) ||
      !Number.isFinite(shiftTypeId)
    ) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Required numeric fields are invalid.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A valid shift date is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (requiredStaffCount == null || requiredStaffCount === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Required staff count must be a whole number between 1 and 1000.',
        code: 'INVALID_REQUEST',
      });
    }

   const scopeError = await validateAssignmentPeriodScope({
      shiftPeriodId,
      divisionId,
      departmentId,
    });
    if (scopeError) {
      return sendApiError(req, res, {
        status: 422,
        error: 'The request could not be completed.',
        details: scopeError,
        code: 'DEPARTMENT_DIVISION_MISMATCH',
      });
    }


    const allowed = await requireDivisionDepartmentAccess(req, res, {
      divisionId,
      departmentId,
    });
    if (!allowed) return;

    const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
      req,
      shiftPeriodId,
    });
    if (approvedEditError) {
      return sendApiError(req, res, {
        status: 403,
        error: 'You do not have permission to perform this action.',
        details: approvedEditError,
        code: 'PERMISSION_DENIED',
        extra: { permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION },
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM shiftly_api.update_shift_assignment_capacity_group(
        $1::int,
        $2::date,
        $3::int,
        $4::int,
        $5::int,
        $6::int,
        $7::int,
        $8::boolean
      )
      `,
      [
        shiftPeriodId,
        shiftDate,
        divisionId,
        departmentId,
        staffTypeId,
        shiftTypeId,
        requiredStaffCount,
        approve,
      ],
    );

    return res.json(result.rows[0]);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error updating assignment capacity group',
    });
  }
});

router.post('/capacity-groups/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Invalid capacity group id.',
        code: 'INVALID_REQUEST',
      });
    }

    const meta = await pool.query(
      `
      SELECT
        g.id,
        g.shift_period_id,
        g.division_id,
        g.department_id
      FROM shiftly_schema.shift_assignment_capacity_groups g
      WHERE g.id = $1
      LIMIT 1
      `,
      [id],
    );
    if (!meta.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested capacity group could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }

    const allowed = await requireDivisionDepartmentAccess(req, res, {
      divisionId: meta.rows[0].division_id,
      departmentId: meta.rows[0].department_id,
    });
    if (!allowed) return;

    const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
      req,
      shiftPeriodId: meta.rows[0].shift_period_id,
    });
    if (approvedEditError) {
      return sendApiError(req, res, {
        status: 403,
        error: 'You do not have permission to perform this action.',
        details: approvedEditError,
        code: 'PERMISSION_DENIED',
        extra: { permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION },
      });
    }

    const result = await pool.query(
      `SELECT * FROM shiftly_api.approve_shift_assignment_capacity_group($1::int)`,
      [id],
    );

    return res.json(result.rows[0]);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error approving assignment capacity group',
    });
  }
});



/**
 * POST /shift-assignments/:id/approve
 *
 * Approves one edited assignment in an already approved period without
 * reopening or reapproving the whole period.
 */
router.post('/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Invalid id.',
        code: 'INVALID_REQUEST',
      });
    }

    const meta = await pool.query(
      `
      SELECT
        sa.id,
        sa.division_id,
        sa.department_id,
        sa.status AS assignment_status,
        sp.status AS period_status
      FROM shiftly_schema.shift_assignments sa
      JOIN shiftly_schema.shift_periods sp ON sp.id = sa.shift_period_id
      WHERE sa.id = $1
      LIMIT 1
      `,
      [id],
    );
    if (!meta.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested record could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }

 
    const periodStatus = String(
      meta.rows[0].period_status || '',
    ).trim().toUpperCase();

    if (periodStatus !== 'APPROVED') {
      return sendApiError(req, res, {
        status: 409,
        error: 'This assignment does not require separate approval.',
        details:
          'Individual assignment approval is only available when the Shift Period is already APPROVED.',
        code: 'INVALID_ASSIGNMENT_APPROVAL_STATE',
      });
    }

    const assignmentStatus = String(
      meta.rows[0].assignment_status || '',
    ).trim().toUpperCase();

    if (assignmentStatus !== 'REQUESTED') {
      return sendApiError(req, res, {
        status: 409,
        error: 'This assignment is not pending approval.',
        details:
          `Only assignments with status REQUESTED can be approved. Current status: ${assignmentStatus || 'UNKNOWN'}.`,
        code: 'INVALID_ASSIGNMENT_APPROVAL_STATE',
      });
    }

    const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
      req,
      assignmentId: id,
    });
    if (approvedEditError) {
      return sendApiError(req, res, {
        status: 403,
        error: 'You do not have permission to perform this action.',
        details: approvedEditError,
        code: 'PERMISSION_DENIED',
        extra: { permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION },
      });
    }

    const allowed = await requireDivisionDepartmentAccess(req, res, {
      divisionId: meta.rows[0].division_id,
      departmentId: meta.rows[0].department_id,
    });
    if (!allowed) return;

    const result = await pool.query(
      `
      UPDATE shiftly_schema.shift_assignments
         SET status = 'APPROVED',
             status_comment = COALESCE($2::text, status_comment),
             updated_at = NOW()
       WHERE id = $1
       AND UPPER(COALESCE(status, '')) = 'REQUESTED'
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
         is_absence,
         absence_type,
         created_at,
         updated_at,
         staff_shift_rule_id,
         required_staff_snapshot,
         assignment_required_staff_count,
         to_char(start_time, 'HH24:MI:SS') AS start_time,
         to_char(end_time, 'HH24:MI:SS') AS end_time
      `,
      [id, req.body?.status_comment ?? req.body?.statusComment ?? null],
    );

   /*
    * The assignment may have changed after the metadata SELECT but before
    * this UPDATE. The status predicate above makes the approval atomic.
    */
   if (!result.rows.length) {
     return sendApiError(req, res, {
       status: 409,
       error: 'This assignment is no longer pending approval.',
       details:
         'Only an assignment whose current status is REQUESTED can be approved.',
       code: 'INVALID_ASSIGNMENT_APPROVAL_STATE',
     });
   }
   

    return res.json(result.rows[0]);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error approving assignment',
    });
  }
});

/**
 * DELETE /shift-assignments/:id/hard
 *
 * ✅ Hard delete an assignment row (real remove).
 * Guards:
 * - caller must have access to the assignment division/department
 * - deleting from an APPROVED period requires the approved-assignment
 *   editing permission
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
      SELECT
        sa.id,
        sa.shift_period_id,
        sa.division_id,
        sa.department_id,
        sp.status AS period_status
      FROM shiftly_schema.shift_assignments sa
      JOIN shiftly_schema.shift_periods sp ON sp.id = sa.shift_period_id
      WHERE sa.id = $1
      `,
      [id],
    );
    if (!meta.rows || meta.rows.length === 0) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested record could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
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
    const allowed = await requireDivisionDepartmentAccess(req, res, {
      divisionId: meta.rows[0].division_id,
      departmentId: meta.rows[0].department_id,
    });
    if (!allowed) return;

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
        assignment_required_staff_count,
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
    return sendPostgresError(req, res, err, {
      action: 'DELETE',
      label: 'Error hard deleting assignment',
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
    const requiredStaffCount = parseRequiredStaffCount(
      b.assignmentRequiredStaffCount ??
        b.assignment_required_staff_count ??
        b.required_staff_count ??
        null,
    );


    if (!Number.isFinite(shiftPeriodId) || !Number.isFinite(departmentId) || !Number.isFinite(userId) || !Number.isFinite(shiftTypeId)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Required numeric fields are invalid.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!shiftDate || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A valid shift date is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!status) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Status is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (startTime === undefined || endTime === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Use a valid time format.',
        code: 'INVALID_REQUEST',
      });
    }
    if (requiredStaffCount === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Required staff count must be a whole number between 1 and 1000.',
        code: 'INVALID_REQUEST',
      });
    }
    if (requiredStaffCount != null) {
      return sendApiError(req, res, {
        status: 400,
        error: 'Required staff count is edited at the shift group level.',
        details: 'Use the capacity group endpoint instead of sending a per-assignment required staff count.',
        code: 'INVALID_REQUEST',
      });
    }

    const scopeError = await validateAssignmentPeriodScope({
      shiftPeriodId,
      divisionId,
      departmentId,
    });
    if (scopeError) {
      return sendApiError(req, res, {
        status: 422,
        error: 'The request could not be completed.',
        details: scopeError,
        code: 'DEPARTMENT_DIVISION_MISMATCH',
      });
    }

    const approvedEditError = await ensureApprovedPeriodAssignmentEditAllowed({
      req,
      shiftPeriodId,
    });
    if (approvedEditError) {
      return sendApiError(req, res, {
        status: 403,
        error: 'You do not have permission to perform this action.',
        details: approvedEditError,
        code: 'PERMISSION_DENIED',
        extra: { permission: EDIT_APPROVED_ASSIGNMENTS_PERMISSION },
      });
    }
    const allowed = await requireDivisionDepartmentAccess(req, res, {
      divisionId,
      departmentId,
    });
    if (!allowed) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
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
        r.assignment_required_staff_count,
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
      await client.query('ROLLBACK');
      return sendInternalError(
        req,
        res,
        new Error('No row returned from create_shift_assignment.'),
        'create-smart returned no row',
      );
    }

      const row = result.rows[0];
      await client.query('COMMIT');
      return res.status(201).json(row);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error creating assignment (create-smart)',
    });
  }
});


// IMPORTANT:
// Mount generic CRUD routes after every custom/static route.
// This prevents createCrudRouter from intercepting routes such as:
// - /mobile-day-details
// - /capacity-groups
// - /create-smart
// - /:id/approve
// - /:id/hard
router.use('/', createCrudRouter(shiftAssignmentsConfig));


module.exports = router;
