const express = require('express');
const ExcelJS = require('exceljs');
const { clinicalRequestContext, clinicalPool } = require('../services/clinicalRequestContext');
const { describeClinicalAttention } = require('../services/clinicalAttentionDetails');
const pool = clinicalPool(require('../db'));
const requirePermission = require('../middleware/requirePermission');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

const router = express.Router();
router.use(clinicalRequestContext);

const OPEN_PATIENT_ADMIN = 'screen:clinical_patient_administration:open';
const OPEN_CLINICAL_UNITS = 'screen:clinical_units:open';
const MANAGE_CLINICAL_UNITS = 'action:clinical_units:manage';
const MANAGE_PATIENT_ADMIN = 'action:clinical_patient_administration:manage';
const OPEN_ACUITY_RULE_SETS = 'screen:clinical_acuity_rule_sets:open';
const OPEN_ACUITY_LEVELS = 'screen:clinical_acuity_levels:open';
const OPEN_ACUITY_FACTORS = 'screen:clinical_acuity_factors:open';
const OPEN_FLOW_RULES = 'screen:clinical_flow_workload_rules:open';
const MANAGE_ACUITY_RULES = 'action:clinical_acuity_rules:manage';
const OPEN_MOBILE_PATIENTS = 'screen:mobile_clinical_patients:open';
const UPDATE_PATIENT_OPERATIONS = 'action:clinical_patient_operations:update';
const OPEN_CLINICAL_COMPETENCIES = 'screen:clinical_competencies:open';
const OPEN_STAFF_COMPETENCIES = 'screen:clinical_staff_competencies:open';
const OPEN_COMPETENCY_REQUIREMENTS = 'screen:clinical_competency_requirements:open';
const OPEN_CAPACITY_POLICIES = 'screen:clinical_capacity_policies:open';
const OPEN_STAFF_POOL = 'screen:clinical_staff_pool:open';
const OPEN_ASSIGNMENT_BOARD = 'screen:clinical_assignment_board:open';
const OPEN_ASSIGNMENT_OPTIMIZER_POLICIES = 'screen:clinical_assignment_optimizer_policies:open';
const OPEN_CLINICAL_ANALYTICS = 'screen:clinical_analytics:open';
const MANAGE_COMPETENCIES = 'action:clinical_competencies:manage';
const MANAGE_CAPACITY_POLICIES = 'action:clinical_capacity_policies:manage';
const OPTIMIZE_ASSIGNMENTS = 'action:clinical_assignments:optimize';
const PUBLISH_ASSIGNMENTS = 'action:clinical_assignments:publish';
const OVERRIDE_ASSIGNMENTS = 'action:clinical_assignments:override';
const REVIEW_ASSIGNMENT_WORKFLOWS = 'action:clinical_assignment_workflows:review';
const EXPORT_CLINICAL_ANALYTICS = 'action:clinical_analytics:export';
const STAFFING_REFERENCE_PERMISSIONS = [
  OPEN_CLINICAL_UNITS,
  OPEN_CLINICAL_COMPETENCIES,
  OPEN_STAFF_COMPETENCIES,
  OPEN_COMPETENCY_REQUIREMENTS,
  OPEN_CAPACITY_POLICIES,
  OPEN_STAFF_POOL,
  OPEN_ASSIGNMENT_BOARD,
  OPEN_ASSIGNMENT_OPTIMIZER_POLICIES,
  OPEN_CLINICAL_ANALYTICS,
  REVIEW_ASSIGNMENT_WORKFLOWS,
];

const UNIT_TYPES = new Set(['GENERAL', 'MED_SURG', 'ICU', 'ED', 'TELEMETRY', 'PERIOP', 'REHAB', 'OTHER']);
const SEX_VALUES = new Set(['FEMALE', 'MALE', 'OTHER', 'UNKNOWN']);
const PATIENT_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'MERGED']);
const ENCOUNTER_STATUSES = new Set(['ACTIVE', 'DISCHARGED', 'CANCELLED', 'TRANSFERRED']);
const ADMISSION_TYPES = new Set(['ELECTIVE', 'EMERGENCY', 'URGENT', 'OBSERVATION', 'TRANSFER', 'OTHER']);

function actorUserId(req) {
  const userId = Number(req.user?.sub ?? req.user?.id);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function parseOptionalInt(value) {
  if (value == null || `${value}`.trim() === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = `${value}`.trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : undefined;
}

function parseBoolean(value, defaultValue) {
  if (value == null || `${value}`.trim() === '') return defaultValue;
  const normalized = `${value}`.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return undefined;
}

function parseRequiredDate(value) {
  const text = value == null ? '' : `${value}`.trim();
  return isCalendarDate(text) ? text : undefined;
}

function sendPastClinicalAssignmentLockedError(req, res) {
  return sendApiError(req, res, {
    status: 409,
    error: 'Past assignment dates are locked. Choose today or a future date to make assignment changes.',
    code: 'CLINICAL_ASSIGNMENT_DATE_LOCKED',
  });
}

async function ensureClinicalAssignmentDateEditable(req, res, shiftDate) {
  const result = await pool.query(
    `SELECT $1::date < CURRENT_DATE AS is_locked`,
    [shiftDate],
  );
  if (result.rows[0]?.is_locked) {
    sendPastClinicalAssignmentLockedError(req, res);
    return false;
  }
  return true;
}

async function ensureClinicalAssignmentRunDateEditable(req, res, runId) {
  const result = await pool.query(
    `
      SELECT shift_date < CURRENT_DATE AS is_locked
      FROM shiftly_schema.clinical_assignment_optimization_runs
      WHERE id = $1
    `,
    [runId],
  );
  if (!result.rows.length) {
    sendApiError(req, res, {
      status: 404,
      error: 'Assignment draft was not found.',
      code: 'CLINICAL_RUN_NOT_FOUND',
    });
    return false;
  }
  if (result.rows[0].is_locked) {
    sendPastClinicalAssignmentLockedError(req, res);
    return false;
  }
  return true;
}

async function ensureClinicalAssignmentWorkflowDateEditable(req, res, workflowId) {
  const result = await pool.query(
    `
      SELECT shift_date < CURRENT_DATE AS is_locked
      FROM shiftly_schema.clinical_assignment_review_workflows
      WHERE id = $1
    `,
    [workflowId],
  );
  if (!result.rows.length) {
    sendApiError(req, res, {
      status: 404,
      error: 'Assignment workflow was not found.',
      code: 'CLINICAL_WORKFLOW_NOT_FOUND',
    });
    return false;
  }
  if (result.rows[0].is_locked) {
    sendPastClinicalAssignmentLockedError(req, res);
    return false;
  }
  return true;
}

function buildFileStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeSheetName(value) {
  return String(value || 'Sheet')
    .replace(/[\\/?*[\]:]/g, ' ')
    .slice(0, 31)
    .trim() || 'Sheet';
}

function parseAnalyticsParams(req, res) {
  const fromDate = parseRequiredDate(req.query.fromDate || req.query.from_date);
  const toDate = parseRequiredDate(req.query.toDate || req.query.to_date);
  const divisionId = parseOptionalInt(req.query.divisionId || req.query.division_id);
  const departmentId = parseOptionalInt(req.query.departmentId || req.query.department_id);
  const clinicalUnitId = parseOptionalInt(req.query.clinicalUnitId || req.query.clinical_unit_id);
  const shiftTypeId = parseOptionalInt(req.query.shiftTypeId || req.query.shift_type_id);
  const staffTypeId = parseOptionalInt(req.query.staffTypeId || req.query.staff_type_id);
  const acuityLevelId = parseOptionalInt(req.query.acuityLevelId || req.query.acuity_level_id);

  if (!fromDate || !toDate) {
    sendApiError(req, res, {
      status: 400,
      error: 'fromDate and toDate are required in YYYY-MM-DD format.',
      code: 'INVALID_REQUEST',
    });
    return null;
  }

  if (
    divisionId === undefined ||
    departmentId === undefined ||
    clinicalUnitId === undefined ||
    shiftTypeId === undefined ||
    staffTypeId === undefined ||
    acuityLevelId === undefined
  ) {
    sendApiError(req, res, {
      status: 400,
      error: 'Numeric analytics filters must be positive integers when provided.',
      code: 'INVALID_REQUEST',
    });
    return null;
  }

  return {
    fromDate,
    toDate,
    divisionId,
    departmentId,
    clinicalUnitId,
    shiftTypeId,
    staffTypeId,
    acuityLevelId,
  };
}

function analyticsValues(userId, params) {
  return [
    userId,
    params.fromDate,
    params.toDate,
    params.divisionId,
    params.departmentId,
    params.clinicalUnitId,
    params.shiftTypeId,
    params.staffTypeId,
    params.acuityLevelId,
  ];
}

function analyticsSql() {
  return `
    SELECT shiftly_api.fn_clinical_monthly_analytics(
      $1, $2::date, $3::date, $4, $5, $6, $7, $8, $9
    ) AS report
  `;
}

function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\w\S*/g, (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
}

function addHeaderStyle(row) {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    };
  });
}

function styleWorksheet(worksheet, headerRowNumber) {
  worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber < headerRowNumber) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      };
    });
  });
}

function addReportContext(worksheet, title, report) {
  worksheet.addRow([title]);
  worksheet.addRow(['From', report.filters?.from_date || '']);
  worksheet.addRow(['To', report.filters?.to_date || '']);
  worksheet.addRow(['Generated at', report.generated_at || '']);
  worksheet.addRow(['Methodology', report.methodology || '']);
  worksheet.addRow([]);
  worksheet.mergeCells('A1:H1');
  worksheet.getCell('A1').font = { bold: true, size: 16 };
  worksheet.getCell('A1').alignment = { horizontal: 'center' };
  for (let i = 2; i <= 5; i += 1) worksheet.getCell(`A${i}`).font = { bold: true };
}

function addKeyValueSheet(workbook, name, title, report, data) {
  const worksheet = workbook.addWorksheet(safeSheetName(name));
  addReportContext(worksheet, title, report);
  const header = worksheet.addRow(['Metric', 'Value']);
  addHeaderStyle(header);
  Object.entries(data || {}).forEach(([key, value]) => {
    const display = value && typeof value === 'object' ? JSON.stringify(value) : value;
    worksheet.addRow([titleCase(key), display ?? '']);
  });
  worksheet.columns = [{ width: 38 }, { width: 26 }];
  styleWorksheet(worksheet, 7);
}

function addTableSheet(workbook, name, title, report, rows, columns) {
  const worksheet = workbook.addWorksheet(safeSheetName(name));
  addReportContext(worksheet, title, report);
  const header = worksheet.addRow(columns.map((column) => column.header));
  addHeaderStyle(header);

  for (const row of Array.isArray(rows) ? rows : []) {
    worksheet.addRow(columns.map((column) => {
      const value = row[column.key];
      if (value == null) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
    }));
  }

  worksheet.columns = columns.map((column) => ({ width: column.width || 18 }));
  styleWorksheet(worksheet, 7);
}

function buildClinicalAnalyticsWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ShiftMix';
  workbook.created = new Date();

  addKeyValueSheet(
    workbook,
    'Executive Summary',
    'Clinical Analytics Executive Summary',
    report,
    report.executive_summary,
  );

  addTableSheet(workbook, 'Acuity', 'Acuity Distribution', report, report.acuity_distribution, [
    { key: 'level_code', header: 'Level Code', width: 16 },
    { key: 'level_name', header: 'Acuity Level', width: 22 },
    { key: 'encounter_count', header: 'Encounters', width: 14 },
    { key: 'assessment_count', header: 'Assessments', width: 14 },
    { key: 'average_score', header: 'Average Score', width: 16 },
    { key: 'average_workload', header: 'Average Workload', width: 18 },
  ]);

  addTableSheet(workbook, 'Staffing Workload', 'Staffing Workload', report, report.staffing_workload, [
    { key: 'shift_date', header: 'Date', width: 14 },
    { key: 'shift_label', header: 'Shift', width: 18 },
    { key: 'unit_name', header: 'Clinical Unit', width: 24 },
    { key: 'staff_type_name', header: 'Staff Type', width: 16 },
    { key: 'user_desc', header: 'Staff', width: 26 },
    { key: 'is_eligible', header: 'Eligible', width: 12 },
    { key: 'max_workload', header: 'Capacity', width: 12 },
    { key: 'assigned_workload', header: 'Assigned Workload', width: 18 },
    { key: 'normalized_utilization', header: 'Utilization', width: 14 },
    { key: 'assigned_patient_count', header: 'Patients', width: 12 },
    { key: 'high_extreme_patient_count', header: 'High/Extreme', width: 14 },
    { key: 'missing_competency_count', header: 'Competency Gaps', width: 16 },
  ]);

  addTableSheet(workbook, 'Optimization', 'Optimizer Outcomes', report, report.optimization, [
    { key: 'run_number', header: 'Run', width: 18 },
    { key: 'optimization_mode', header: 'Mode', width: 20 },
    { key: 'optimization_status', header: 'Status', width: 16 },
    { key: 'shift_date', header: 'Date', width: 14 },
    { key: 'shift_label', header: 'Shift', width: 18 },
    { key: 'unit_name', header: 'Clinical Unit', width: 24 },
    { key: 'balance_gap_before', header: 'Gap Before', width: 14 },
    { key: 'balance_gap_after', header: 'Gap After', width: 14 },
    { key: 'balance_improvement', header: 'Improvement', width: 14 },
    { key: 'patients_moved', header: 'Moved', width: 12 },
    { key: 'unassigned_patients', header: 'Unassigned', width: 14 },
    { key: 'modified_recommendations', header: 'Modified', width: 12 },
    { key: 'source', header: 'Source', width: 14 },
    { key: 'action_by', header: 'Action By', width: 25 },
    { key: 'action_date_time', header: 'Action Date/Time', width: 23 },
  ]);

  addTableSheet(workbook, 'Handover Workflow', 'Handover and Workflow', report, report.workflows, [
    { key: 'workflow_number', header: 'Workflow', width: 20 },
    { key: 'workflow_status', header: 'Status', width: 18 },
    { key: 'trigger_type', header: 'Trigger', width: 22 },
    { key: 'shift_date', header: 'Date', width: 14 },
    { key: 'shift_label', header: 'Shift', width: 18 },
    { key: 'unit_name', header: 'Clinical Unit', width: 24 },
    { key: 'reason_summary', header: 'Reason', width: 46 },
    { key: 'hours_to_publish', header: 'Hours To Publish', width: 18 },
    { key: 'source', header: 'Source', width: 14 },
    { key: 'action_by', header: 'Action By', width: 25 },
    { key: 'action_date_time', header: 'Action Date/Time', width: 23 },
  ]);

  addTableSheet(workbook, 'Exceptions', 'Exceptions / Unassigned / Capacity Issues', report, report.exceptions, [
    { key: 'exception_type', header: 'Exception', width: 24 },
    { key: 'severity', header: 'Severity', width: 12 },
    { key: 'shift_date', header: 'Date', width: 14 },
    { key: 'shift_label', header: 'Shift', width: 18 },
    { key: 'unit_name', header: 'Clinical Unit', width: 24 },
    { key: 'detail', header: 'Detail', width: 48 },
    { key: 'occurrence_count', header: 'Count', width: 12 },
    { key: 'evidence_reference', header: 'Evidence reference', width: 30 },
    { key: 'record_status', header: 'Evidence status', width: 30 },
    { key: 'source', header: 'Source', width: 14 },
    { key: 'action_by', header: 'Action By', width: 25 },
    { key: 'action_date_time', header: 'Action Date/Time', width: 23 },
  ]);

  return workbook;
}

function requirePositiveId(req, res, rawValue, label) {
  const parsed = parseOptionalInt(rawValue);
  if (parsed === undefined || parsed === null) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} must be a positive integer.`,
      code: 'INVALID_REQUEST',
    });
    return null;
  }
  return parsed;
}

function requireAnyClinicalPermission(permissionKeys) {
  return async (req, res, next) => {
    const userId = actorUserId(req);
    if (!userId) {
      return sendApiError(req, res, {
        status: 401,
        error: 'Please sign in to continue.',
        code: 'AUTH_REQUIRED',
      });
    }

    try {
      const result = await pool.query(
        `SELECT EXISTS (
           SELECT 1
           FROM unnest($2::text[]) AS p(permission_key)
           WHERE shiftly_api.fn_user_has_permission($1, p.permission_key)
         ) AS ok`,
        [userId, permissionKeys],
      );
      if (!result.rows[0]?.ok) {
        return sendApiError(req, res, {
          status: 403,
          error: 'You do not have permission to perform this action.',
          code: 'PERMISSION_DENIED',
          extra: { permissions: permissionKeys },
        });
      }
      return next();
    } catch (err) {
      return sendPostgresError(req, res, err, {
        label: 'Permission check failed',
      });
    }
  };
}

function pickBody(req, allowed) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const picked = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      picked[key] = body[key];
    }
  }
  return picked;
}

function buildInsert(table, body, returning = '*') {
  const keys = Object.keys(body);
  const placeholders = keys.map((_, index) => `$${index + 1}`);
  return {
    sql: `
      INSERT INTO ${table} (${keys.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING ${returning}
    `,
    values: keys.map((key) => body[key]),
  };
}

function buildUpdate(table, idColumn, idValue, body, returning = '*') {
  const keys = Object.keys(body);
  const sets = keys.map((key, index) => `${key} = $${index + 1}`);
  return {
    sql: `
      UPDATE ${table}
      SET ${sets.join(', ')}
      WHERE ${idColumn} = $${keys.length + 1}
      RETURNING ${returning}
    `,
    values: [...keys.map((key) => body[key]), idValue],
  };
}

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function cleanUpper(value) {
  const text = cleanText(value);
  return text == null ? null : text.toUpperCase();
}

function requireText(req, res, value, label, maxLength) {
  const text = cleanText(value);
  if (text == null) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} is required.`,
      code: 'INVALID_REQUEST',
    });
    return undefined;
  }
  if (maxLength && text.length > maxLength) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} must be ${maxLength} characters or fewer.`,
      code: 'INVALID_REQUEST',
    });
    return undefined;
  }
  return text;
}

function optionalDate(req, res, value, label) {
  const text = cleanText(value);
  if (text == null) return null;
  if (typeof value !== 'string' || !isCalendarDate(text)) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} must be a valid calendar date in YYYY-MM-DD format.`,
      code: 'INVALID_REQUEST',
    });
    return undefined;
  }
  return text;
}

function isCalendarDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function optionalTimestamp(req, res, value, label) {
  const text = cleanText(value);
  if (text == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?$/.test(text)
      || !isCalendarDate(text.slice(0, 10))
      || (text.length > 10 && (Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59))
      || (text.length > 16 && Number(text.slice(17, 19)) > 59)) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} must be a valid local date/time (YYYY-MM-DD HH:mm:ss), without a timezone.`,
      code: 'INVALID_REQUEST',
    });
    return undefined;
  }
  return text;
}

// Preserve omitted fields on edits; validate optional text against actual column sizes.
function validateAdminFields(req, res, body, source, partial, limits) {
  if (partial) {
    for (const key of Object.keys(body)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)
          && !(['current_clinical_unit_id', 'division_id', 'department_id'].includes(key)
            && (source.current_clinical_unit_id != null || source.clinical_unit_id != null))) delete body[key];
    }
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (body[key] != null && (typeof source[key] !== 'string' || body[key].length > limit)) {
      sendApiError(req, res, { status: 400, error: `${key} must be text of ${limit} characters or fewer.`, code: 'INVALID_REQUEST' });
      return null;
    }
  }
  if (body.source_type != null && !['MANUAL', 'DEMO', 'EXTERNAL'].includes(body.source_type)) {
    sendApiError(req, res, { status: 400, error: 'source_type must be MANUAL, DEMO or EXTERNAL.', code: 'INVALID_REQUEST' });
    return null;
  }
  return body;
}

function enumValue(req, res, value, label, allowed, defaultValue = null) {
  const text = cleanUpper(value);
  const normalized = text ?? defaultValue;
  if (normalized == null) return null;
  if (!allowed.has(normalized)) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} must be one of: ${Array.from(allowed).join(', ')}.`,
      code: 'INVALID_REQUEST',
    });
    return undefined;
  }
  return normalized;
}

function optionalNonNegativeInt(req, res, value, label) {
  const text = cleanText(value);
  if (text == null) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    sendApiError(req, res, {
      status: 400,
      error: `${label} must be a non-negative integer.`,
      code: 'INVALID_REQUEST',
    });
    return undefined;
  }
  return parsed;
}

function normalizeUnitBody(req, res, { partial = false } = {}) {
  const body = {};
  const source = req.body || {};
  const divisionId = parseOptionalInt(source.division_id);
  const departmentId = parseOptionalInt(source.department_id);
  const unitCode = partial && !Object.prototype.hasOwnProperty.call(source, 'unit_code')
    ? null
    : requireText(req, res, source.unit_code, 'unit_code', 40);
  const unitName = partial && !Object.prototype.hasOwnProperty.call(source, 'unit_name')
    ? null
    : requireText(req, res, source.unit_name, 'unit_name', 160);
  const unitType = enumValue(req, res, source.unit_type, 'unit_type', UNIT_TYPES, 'GENERAL');
  const bedCount = optionalNonNegativeInt(req, res, source.bed_count, 'bed_count');
  const isActive = parseBoolean(source.is_active, true);
  const isDemo = parseBoolean(source.is_demo, false);

  if (divisionId === undefined || (!partial && divisionId == null)) {
    sendApiError(req, res, { status: 400, error: 'division_id must be a positive integer.', code: 'INVALID_REQUEST' });
    return null;
  }
  if (departmentId === undefined || (!partial && departmentId == null)) {
    sendApiError(req, res, { status: 400, error: 'department_id must be a positive integer.', code: 'INVALID_REQUEST' });
    return null;
  }
  if (unitCode === undefined || unitName === undefined || unitType === undefined || bedCount === undefined || isActive === undefined || isDemo === undefined) return null;

  if (divisionId != null) body.division_id = divisionId;
  if (departmentId != null) body.department_id = departmentId;
  if (unitCode != null) body.unit_code = unitCode.toUpperCase();
  if (unitName != null) body.unit_name = unitName;
  if (unitType != null) body.unit_type = unitType;
  body.floor_label = cleanText(source.floor_label);
  body.default_room_prefix = cleanText(source.default_room_prefix);
  body.bed_count = bedCount;
  body.source_type = cleanUpper(source.source_type) || 'MANUAL';
  body.external_source_system = cleanText(source.external_source_system);
  body.external_unit_id = cleanText(source.external_unit_id);
  body.is_demo = isDemo;
  body.is_active = isActive;
  return body;
}

function normalizePatientBody(req, res, { partial = false } = {}) {
  const source = req.body || {};
  const body = {};
  const publicId = partial && !Object.prototype.hasOwnProperty.call(source, 'patient_public_id')
    ? null
    : requireText(req, res, source.patient_public_id, 'patient_public_id', 80);
  if (publicId === undefined) return null;
  const displayName = partial && !Object.prototype.hasOwnProperty.call(source, 'display_name')
    ? null
    : requireText(req, res, source.display_name, 'display_name', 160);
  if (displayName === undefined) return null;
  const dob = optionalDate(req, res, source.date_of_birth, 'date_of_birth');
  if (dob === undefined) return null;
  const sex = enumValue(req, res, source.sex, 'sex', SEX_VALUES);
  if (sex === undefined) return null;
  const patientStatus = enumValue(req, res, source.patient_status, 'patient_status', PATIENT_STATUSES, 'ACTIVE');
  if (patientStatus === undefined) return null;
  const isDemo = parseBoolean(source.is_demo, false);

  if (isDemo === undefined) {
    sendApiError(req, res, { status: 400, error: 'is_demo must be true or false.', code: 'INVALID_REQUEST' });
    return null;
  }

  if (publicId === undefined || displayName === undefined || dob === undefined || sex === undefined || patientStatus === undefined || isDemo === undefined) return null;
  if (publicId != null) body.patient_public_id = publicId;
  if (displayName != null) body.display_name = displayName;
  body.date_of_birth = dob;
  body.sex = sex;
  body.patient_status = patientStatus;
  body.source_type = cleanUpper(source.source_type) || 'MANUAL';
  body.external_source_system = cleanText(source.external_source_system);
  body.external_patient_id = cleanText(source.external_patient_id);
  body.is_demo = isDemo;
  return validateAdminFields(req, res, body, source, partial, {
    patient_public_id: 80, display_name: 160, external_source_system: 80, external_patient_id: 120,
  });
}

async function normalizeEncounterBody(req, res, source, { partial = false } = {}) {
  const body = {};
  // On create, blank/omitted business numbers are generated by the database.
  const encounterNumber = !partial && cleanText(source.encounter_number) == null
    ? null
    : partial && !Object.prototype.hasOwnProperty.call(source, 'encounter_number')
      ? null
      : requireText(req, res, source.encounter_number, 'encounter_number', 80);
  if (encounterNumber === undefined) return null;
  const status = enumValue(req, res, source.encounter_status, 'encounter_status', ENCOUNTER_STATUSES, 'ACTIVE');
  if (status === undefined) return null;
  const admissionType = enumValue(req, res, source.admission_type, 'admission_type', ADMISSION_TYPES);
  if (admissionType === undefined) return null;
  const admittedAt = partial && !Object.prototype.hasOwnProperty.call(source, 'admitted_at')
    ? null
    : optionalTimestamp(req, res, source.admitted_at, 'admitted_at');
  if (admittedAt === undefined) return null;
  const expectedDischargeAt = optionalTimestamp(req, res, source.expected_discharge_at, 'expected_discharge_at');
  if (expectedDischargeAt === undefined) return null;
  const dischargedAt = optionalTimestamp(req, res, source.discharged_at, 'discharged_at');
  if (dischargedAt === undefined) return null;
  const unitId = parseOptionalInt(source.current_clinical_unit_id ?? source.clinical_unit_id);
  const isDemo = parseBoolean(source.is_demo, false);

  if (isDemo === undefined) {
    sendApiError(req, res, { status: 400, error: 'is_demo must be true or false.', code: 'INVALID_REQUEST' });
    return null;
  }

  if (encounterNumber === undefined || status === undefined || admissionType === undefined || admittedAt === undefined || expectedDischargeAt === undefined || dischargedAt === undefined || isDemo === undefined) return null;
  if (partial && Object.prototype.hasOwnProperty.call(source, 'admitted_at') && admittedAt == null) {
    sendApiError(req, res, { status: 400, error: 'admitted_at is required when editing admission time.', code: 'INVALID_REQUEST' });
    return null;
  }
  if (admittedAt != null && dischargedAt != null
      && Date.parse(dischargedAt.replace(' ', 'T') + (dischargedAt.length === 10 ? 'T00:00:00Z' : 'Z'))
        < Date.parse(admittedAt.replace(' ', 'T') + (admittedAt.length === 10 ? 'T00:00:00Z' : 'Z'))) {
    sendApiError(req, res, { status: 400, error: 'discharged_at must be on or after admitted_at.', code: 'INVALID_REQUEST' });
    return null;
  }
  if (unitId === undefined || (unitId == null && (!partial
      || Object.prototype.hasOwnProperty.call(source, 'clinical_unit_id')
      || Object.prototype.hasOwnProperty.call(source, 'current_clinical_unit_id')))) {
    sendApiError(req, res, { status: 400, error: 'clinical_unit_id must be a positive integer.', code: 'INVALID_REQUEST' });
    return null;
  }

  if (unitId != null) {
    const unitResult = await pool.query(
      `SELECT id, division_id, department_id FROM shiftly_schema.clinical_units u
       WHERE id = $1 AND (is_active = true OR EXISTS (
         SELECT 1 FROM shiftly_schema.clinical_encounters e
         WHERE e.id = $2 AND e.current_clinical_unit_id = u.id
       ))`,
      [unitId, partial ? req.params.id : null],
    );
    if (!unitResult.rows.length) {
      sendApiError(req, res, { status: 400, error: 'Clinical unit is not active or does not exist.', code: 'INVALID_REQUEST' });
      return null;
    }
    body.current_clinical_unit_id = unitId;
    body.division_id = unitResult.rows[0].division_id;
    body.department_id = unitResult.rows[0].department_id;
  }

  if (encounterNumber != null) body.encounter_number = encounterNumber;
  if (status != null) body.encounter_status = status;
  body.admission_type = admissionType;
  if (admittedAt != null) body.admitted_at = admittedAt;
  body.expected_discharge_at = expectedDischargeAt;
  body.discharged_at = dischargedAt;
  body.discharge_disposition = cleanText(source.discharge_disposition);
  body.room_label = cleanText(source.room_label);
  body.bed_label = cleanText(source.bed_label);
  body.source_type = cleanUpper(source.source_type) || 'MANUAL';
  body.external_source_system = cleanText(source.external_source_system);
  body.external_encounter_id = cleanText(source.external_encounter_id);
  body.is_demo = isDemo;
  return validateAdminFields(req, res, body, source, partial, {
    encounter_number: 80, discharge_disposition: 80, room_label: 40, bed_label: 40,
    external_source_system: 80, external_encounter_id: 120,
  });
}

async function insertRow(req, res, table, allowed, contextLabel) {
  const body = pickBody(req, allowed);
  if (!Object.keys(body).length) {
    return sendApiError(req, res, {
      status: 400,
      error: 'No valid fields were provided.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const query = buildInsert(table, body);
    const result = await pool.query(query.sql, query.values);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: contextLabel,
    });
  }
}

async function updateRow(req, res, table, idColumn, allowed, contextLabel) {
  const id = requirePositiveId(req, res, req.params.id, 'id');
  if (!id) return null;

  const body = pickBody(req, allowed);
  if (!Object.keys(body).length) {
    return sendApiError(req, res, {
      status: 400,
      error: 'No valid fields were provided.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const query = buildUpdate(table, idColumn, id, body);
    const result = await pool.query(query.sql, query.values);
    if (!result.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested record could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: contextLabel,
    });
  }
}

router.get('/units', requireAnyClinicalPermission([OPEN_PATIENT_ADMIN, OPEN_CLINICAL_UNITS]), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM shiftly_api.fn_clinical_units($1)`,
      [userId],
    );
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical units',
    });
  }
});

router.post('/units', requirePermission(MANAGE_CLINICAL_UNITS), async (req, res) => {
  const body = normalizeUnitBody(req, res);
  if (!body) return null;
  req.body = body;
  return insertRow(
    req,
    res,
    'shiftly_schema.clinical_units',
    Object.keys(body),
    'Error creating clinical unit',
  );
});

router.put('/units/:id', requirePermission(MANAGE_CLINICAL_UNITS), async (req, res) => {
  const body = normalizeUnitBody(req, res, { partial: true });
  if (!body) return null;
  req.body = body;
  return updateRow(
    req,
    res,
    'shiftly_schema.clinical_units',
    'id',
    Object.keys(body),
    'Error updating clinical unit',
  );
});

router.get('/patient-encounters', requirePermission(OPEN_PATIENT_ADMIN), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const includeDischarged = parseBoolean(req.query.includeDischarged, true);
  const unitId = parseOptionalInt(req.query.unitId);

  if (includeDischarged === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'includeDischarged must be true or false.',
      code: 'INVALID_REQUEST',
    });
  }
  if (unitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'unitId must be a positive integer when provided.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM shiftly_api.fn_clinical_patient_encounters($1, $2, $3, NULL)`,
      [userId, includeDischarged, unitId],
    );
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical patient encounters',
    });
  }
});

router.get('/patients/:patientId', requirePermission(OPEN_PATIENT_ADMIN), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const patientId = parseOptionalInt(req.params.patientId);
  if (patientId === undefined || patientId === null) {
    return sendApiError(req, res, {
      status: 400,
      error: 'patientId must be a positive integer.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM shiftly_api.fn_clinical_patient_encounters($1, true, NULL, $2)`,
      [userId, patientId],
    );

    if (!result.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested patient could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }

    const first = result.rows[0];
    return res.json({
      patient: {
        patient_id: first.patient_id,
        patient_public_id: first.patient_public_id,
        display_name: first.display_name,
        date_of_birth: first.date_of_birth,
        sex: first.sex,
        patient_status: first.patient_status,
        patient_source_type: first.patient_source_type,
        patient_external_source_system: first.patient_external_source_system,
        patient_external_patient_id: first.patient_external_patient_id,
        patient_is_demo: first.patient_is_demo,
      },
      encounters: result.rows,
    });
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading clinical patient detail',
    });
  }
});

function sendPatientAdminError(req, res, err, context) {
  // The DB check is authoritative even for partial updates and concurrent edits.
  if (err.constraint === 'chk_clinical_encounters_dates') {
    return sendApiError(req, res, { status: 400,
      error: 'Discharged at must be on or after admitted at.', code: 'INVALID_ENCOUNTER_DATES' });
  }
  if (err.code === '23505' && err.table === 'clinical_encounters') {
    return sendApiError(req, res, { status: 409,
      error: 'This encounter number or external encounter reference already exists. Refresh the patient before trying again.', code: 'DUPLICATE_ENCOUNTER' });
  }
  if (err.code === '23505' && err.table === 'clinical_patients') {
    return sendApiError(req, res, { status: 409,
      error: 'This patient identifier or external patient reference already exists. Open the existing patient instead.', code: 'DUPLICATE_PATIENT' });
  }
  return sendPostgresError(req, res, err, context);
}

router.post('/patients', requirePermission(MANAGE_PATIENT_ADMIN), async (req, res) => {
  const patientBody = normalizePatientBody(req, res);
  if (!patientBody) return null;
  if (req.body?.encounter != null
      && (typeof req.body.encounter !== 'object' || Array.isArray(req.body.encounter))) {
    return sendApiError(req, res, { status: 400, error: 'encounter must be an object.', code: 'INVALID_REQUEST' });
  }
  const rawEncounter = req.body?.encounter && typeof req.body.encounter === 'object'
    ? req.body.encounter
    : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const patientInsert = buildInsert('shiftly_schema.clinical_patients', patientBody);
    const patientResult = await client.query(patientInsert.sql, patientInsert.values);
    const patient = patientResult.rows[0];
    let encounter = null;

    if (rawEncounter) {
      const encounterBody = await normalizeEncounterBody(req, res, rawEncounter);
      if (!encounterBody) {
        await client.query('ROLLBACK');
        return null;
      }
      encounterBody.patient_id = patient.id;
      const encounterInsert = buildInsert('shiftly_schema.clinical_encounters', encounterBody);
      const encounterResult = await client.query(encounterInsert.sql, encounterInsert.values);
      encounter = encounterResult.rows[0];
    }

    await client.query('COMMIT');
    return res.status(201).json({ patient, encounter });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendPatientAdminError(req, res, err, {
      action: 'CREATE',
      label: 'Error creating clinical patient',
    });
  } finally {
    client.release();
  }
});

router.put('/patients/:patientId', requirePermission(MANAGE_PATIENT_ADMIN), async (req, res) => {
  const patientId = requirePositiveId(req, res, req.params.patientId, 'patientId');
  if (!patientId) return null;
  const body = normalizePatientBody(req, res, { partial: true });
  if (!body) return null;
  if (!Object.keys(body).length) {
    return sendApiError(req, res, {
      status: 400,
      error: 'No valid patient fields were provided.',
      code: 'INVALID_REQUEST',
    });
  }
  const query = buildUpdate('shiftly_schema.clinical_patients', 'id', patientId, body);
  try {
    const result = await pool.query(query.sql, query.values);
    if (!result.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested patient could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendPatientAdminError(req, res, err, {
      action: 'UPDATE',
      label: 'Error updating clinical patient',
    });
  }
});

router.post('/patients/:patientId/encounters', requirePermission(MANAGE_PATIENT_ADMIN), async (req, res) => {
  const patientId = requirePositiveId(req, res, req.params.patientId, 'patientId');
  if (!patientId) return null;
  const body = await normalizeEncounterBody(req, res, req.body || {});
  if (!body) return null;
  body.patient_id = patientId;
  const query = buildInsert('shiftly_schema.clinical_encounters', body);
  try {
    const patientExists = await pool.query(
      `SELECT 1 FROM shiftly_schema.clinical_patients WHERE id = $1`,
      [patientId],
    );
    if (!patientExists.rows.length) {
      return sendApiError(req, res, { status: 404, error: 'The requested patient could not be found.', code: 'RESOURCE_NOT_FOUND' });
    }
    const result = await pool.query(query.sql, query.values);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return sendPatientAdminError(req, res, err, {
      action: 'CREATE',
      label: 'Error creating clinical encounter',
    });
  }
});

router.put('/encounters/:id', requirePermission(MANAGE_PATIENT_ADMIN), async (req, res) => {
  const encounterId = requirePositiveId(req, res, req.params.id, 'id');
  if (!encounterId) return null;
  const body = await normalizeEncounterBody(req, res, req.body || {}, { partial: true });
  if (!body) return null;
  if (!Object.keys(body).length) {
    return sendApiError(req, res, { status: 400, error: 'No valid encounter fields were provided.', code: 'INVALID_REQUEST' });
  }
  const query = buildUpdate('shiftly_schema.clinical_encounters', 'id', encounterId, body);
  try {
    const result = await pool.query(query.sql, query.values);
    if (!result.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested encounter could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return sendPatientAdminError(req, res, err, {
      action: 'UPDATE',
      label: 'Error updating clinical encounter',
    });
  }
});

router.get('/mobile/patients', requirePermission(OPEN_MOBILE_PATIENTS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const unitId = parseOptionalInt(req.query.unitId);
  const includeClosed = parseBoolean(req.query.includeClosed, false);
  if (unitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'unitId must be a positive integer when provided.',
      code: 'INVALID_REQUEST',
    });
  }
  if (includeClosed === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'includeClosed must be true or false.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM shiftly_api.fn_clinical_mobile_patient_encounters($1, $2, $3)`,
      [userId, unitId, includeClosed],
    );
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading mobile clinical patients',
    });
  }
});

router.get('/encounters/:encounterId/history', requireAnyClinicalPermission([OPEN_PATIENT_ADMIN, OPEN_MOBILE_PATIENTS]), async (req, res) => {
  const encounterId = requirePositiveId(req, res, req.params.encounterId, 'encounterId');
  if (!encounterId) return null;
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) {
    return sendApiError(req, res, { status: 400, error: 'Invalid history offset.', code: 'INVALID_INPUT' });
  }
  try {
    const result = await pool.query(
      'SELECT shiftly_api.fn_clinical_patient_history($1, $2, $3) AS history',
      [actorUserId(req), encounterId, offset],
    );
    return res.json(result.rows[0].history);
  } catch (err) {
    return sendPostgresError(req, res, err, { action: 'GET', label: 'Error loading clinical patient history' });
  }
});

router.get('/mobile/patients/:encounterId', requirePermission(OPEN_MOBILE_PATIENTS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const encounterId = requirePositiveId(req, res, req.params.encounterId, 'encounterId');
  if (!encounterId) return null;

  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_mobile_patient_detail($1, $2) AS patient`,
      [userId, encounterId],
    );
    const patient = result.rows[0]?.patient;
    if (!patient) {
      return sendApiError(req, res, {
        status: 404,
        error: 'The requested patient encounter could not be found.',
        code: 'RESOURCE_NOT_FOUND',
      });
    }
    return res.json(patient);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading mobile clinical patient detail',
    });
  }
});

router.get('/mobile/reference-data', requirePermission(OPEN_MOBILE_PATIENTS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  try {
    const [units, statuses, factors, adtEventTypes] = await Promise.all([
      pool.query(`SELECT * FROM shiftly_api.fn_clinical_mobile_units($1)`, [userId]),
      pool.query(`
        SELECT *
        FROM shiftly_schema.clinical_patient_clinical_status_types
        WHERE is_active = true
        ORDER BY severity_order, status_name
      `),
      pool.query(`
        SELECT f.*, c.category_code, c.category_name
        FROM shiftly_schema.clinical_acuity_factors f
        JOIN shiftly_schema.clinical_acuity_factor_categories c ON c.id = f.category_id
        WHERE f.is_active = true
          AND c.is_active = true
          AND f.effective_start_at <= CURRENT_TIMESTAMP
          AND (f.effective_end_at IS NULL OR f.effective_end_at > CURRENT_TIMESTAMP)
        ORDER BY c.display_order, f.display_order, f.factor_name, f.id
      `),
      pool.query(`
        SELECT *
        FROM shiftly_schema.clinical_adt_event_types
        WHERE is_active = true
        ORDER BY display_order, event_name, id
      `),
    ]);

    return res.json({
      units: units.rows,
      clinical_statuses: statuses.rows,
      factors: factors.rows,
      adt_event_types: adtEventTypes.rows,
    });
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading mobile clinical reference data',
    });
  }
});

router.post('/mobile/patients/:encounterId/state', requirePermission(UPDATE_PATIENT_OPERATIONS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const encounterId = requirePositiveId(req, res, req.params.encounterId, 'encounterId');
  if (!encounterId) return null;

  const clinicalStatus = String(req.body?.clinical_status || '').trim().toUpperCase();
  if (!clinicalStatus) {
    return sendApiError(req, res, {
      status: 400,
      error: 'clinical_status is required.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_mobile_update_state($1, $2, $3, $4, 'MANUAL', CURRENT_TIMESTAMP::timestamp without time zone) AS patient`,
      [userId, encounterId, clinicalStatus, req.body?.summary ?? null],
    );
    return res.status(201).json(result.rows[0].patient);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error updating patient clinical state',
    });
  }
});

router.post('/mobile/patients/:encounterId/factors', requirePermission(UPDATE_PATIENT_OPERATIONS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const encounterId = requirePositiveId(req, res, req.params.encounterId, 'encounterId');
  const factorId = parseOptionalInt(req.body?.factor_id);
  if (!encounterId) return null;
  if (factorId === undefined || factorId === null) {
    return sendApiError(req, res, {
      status: 400,
      error: 'factor_id must be a positive integer.',
      code: 'INVALID_REQUEST',
    });
  }

  const factorValue = Number(req.body?.factor_value ?? 1);
  if (!Number.isFinite(factorValue) || factorValue < -10 || factorValue > 10) {
    return sendApiError(req, res, {
      status: 400,
      error: 'factor_value must be between -10 and 10.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_mobile_update_factor($1, $2, $3, $4, $5, $6, 'MANUAL', CURRENT_TIMESTAMP::timestamp without time zone) AS patient`,
      [
        userId,
        encounterId,
        factorId,
        req.body?.is_present !== false,
        factorValue,
        req.body?.notes ?? null,
      ],
    );
    return res.status(201).json(result.rows[0].patient);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error updating patient clinical factor',
    });
  }
});

router.post('/mobile/patients/:encounterId/flow-events', requirePermission(UPDATE_PATIENT_OPERATIONS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const encounterId = requirePositiveId(req, res, req.params.encounterId, 'encounterId');
  const eventTypeId = parseOptionalInt(req.body?.event_type_id);
  const targetUnitId = parseOptionalInt(req.body?.target_clinical_unit_id);
  if (!encounterId) return null;
  if (eventTypeId === undefined || eventTypeId === null) {
    return sendApiError(req, res, {
      status: 400,
      error: 'event_type_id must be a positive integer.',
      code: 'INVALID_REQUEST',
    });
  }
  if (targetUnitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'target_clinical_unit_id must be a positive integer when provided.',
      code: 'INVALID_REQUEST',
    });
  }

  const eventValue = Number(req.body?.event_value ?? 1);
  if (!Number.isFinite(eventValue) || eventValue < -10 || eventValue > 10) {
    return sendApiError(req, res, {
      status: 400,
      error: 'event_value must be between -10 and 10.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_mobile_record_flow_event($1, $2, $3, $4, CURRENT_TIMESTAMP::timestamp without time zone, $5, $6, $7, $8, 'MANUAL') AS patient`,
      [
        userId,
        encounterId,
        eventTypeId,
        eventValue,
        targetUnitId,
        req.body?.room_label ?? null,
        req.body?.bed_label ?? null,
        req.body?.notes ?? null,
      ],
    );
    return res.status(201).json(result.rows[0].patient);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error recording patient flow event',
    });
  }
});

router.get('/staffing/reference-data', requireAnyClinicalPermission(STAFFING_REFERENCE_PERMISSIONS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  try {
    const userVisibility = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM unnest($2::text[]) AS p(permission_key)
         WHERE shiftly_api.fn_user_has_permission($1, p.permission_key)
       ) AS ok`,
      [userId, [OPEN_STAFF_COMPETENCIES, MANAGE_COMPETENCIES]],
    );
    const canSeeStaffUsers = Boolean(userVisibility.rows[0]?.ok);
    const [
      units,
      users,
      staffTypes,
      shiftTypes,
      competencies,
      ruleSets,
      factors,
      levels,
    ] = await Promise.all([
      pool.query(`SELECT * FROM shiftly_api.fn_clinical_units($1)`, [userId]),
      canSeeStaffUsers ? pool.query(`
        SELECT id, empno, user_name, user_desc, staff_type_id, email, is_active
        FROM shiftly_schema.users
        ORDER BY is_active DESC, user_desc NULLS LAST, user_name, id
      `) : Promise.resolve({ rows: [] }),
      pool.query(`
        SELECT *
        FROM shiftly_schema.staff_types
        ORDER BY is_active DESC, staff_type_name, id
      `),
      pool.query(`
        SELECT *
        FROM shiftly_schema.shift_types
        ORDER BY is_active DESC, start_time, shift_label, id
      `),
      pool.query(`
        SELECT *
        FROM shiftly_schema.clinical_competencies
        ORDER BY is_active DESC, competency_name, id
      `),
      pool.query(`
        SELECT *
        FROM shiftly_schema.clinical_acuity_rule_sets
        ORDER BY is_active DESC, rule_code, version_number DESC, id DESC
      `),
      pool.query(`
        SELECT f.*, c.category_code, c.category_name
        FROM shiftly_schema.clinical_acuity_factors f
        JOIN shiftly_schema.clinical_acuity_factor_categories c ON c.id = f.category_id
        ORDER BY f.is_active DESC, c.display_order, f.display_order, f.factor_name, f.id
      `),
      pool.query(`
        SELECT l.*, rs.rule_code, rs.rule_name, rs.version_number
        FROM shiftly_schema.clinical_acuity_levels l
        JOIN shiftly_schema.clinical_acuity_rule_sets rs ON rs.id = l.rule_set_id
        ORDER BY rs.rule_code, rs.version_number DESC, l.display_order, l.min_score, l.id
      `),
    ]);

    return res.json({
      units: units.rows,
      users: users.rows,
      staff_types: staffTypes.rows,
      shift_types: shiftTypes.rows,
      competencies: competencies.rows,
      rule_sets: ruleSets.rows,
      factors: factors.rows,
      levels: levels.rows,
    });
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical staffing reference data',
    });
  }
});

router.get('/competencies', requirePermission(OPEN_CLINICAL_COMPETENCIES), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM shiftly_schema.clinical_competencies
      ORDER BY is_active DESC, competency_name, id
    `);
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical competencies',
    });
  }
});

router.post('/competencies', requirePermission(MANAGE_COMPETENCIES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_competencies', [
    'competency_code',
    'competency_name',
    'description',
    'effective_start_date',
    'effective_end_date',
    'is_demo',
    'is_active',
  ], 'Error creating clinical competency'));

router.put('/competencies/:id', requirePermission(MANAGE_COMPETENCIES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_competencies', 'id', [
    'competency_code',
    'competency_name',
    'description',
    'effective_start_date',
    'effective_end_date',
    'is_demo',
    'is_active',
  ], 'Error updating clinical competency'));

router.get('/staff-competencies', requirePermission(OPEN_STAFF_COMPETENCIES), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sc.*,
        u.empno,
        u.user_name,
        u.user_desc,
        st.staff_type_name,
        c.competency_code,
        c.competency_name
      FROM shiftly_schema.clinical_staff_competencies sc
      JOIN shiftly_schema.users u ON u.id = sc.user_id
      LEFT JOIN shiftly_schema.staff_types st ON st.id = u.staff_type_id
      JOIN shiftly_schema.clinical_competencies c ON c.id = sc.competency_id
      ORDER BY sc.is_active DESC, u.user_desc NULLS LAST, u.user_name, c.competency_name, sc.valid_from DESC
    `);
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading staff clinical competencies',
    });
  }
});

router.post('/staff-competencies', requirePermission(MANAGE_COMPETENCIES), async (req, res) => {
  const body = pickBody(req, [
    'user_id',
    'competency_id',
    'valid_from',
    'valid_to',
    'source_type',
    'comment',
    'is_demo',
    'is_active',
  ]);
  body.created_by = actorUserId(req);
  req.body = body;
  return insertRow(
    req,
    res,
    'shiftly_schema.clinical_staff_competencies',
    Object.keys(body),
    'Error creating staff clinical competency',
  );
});

router.put('/staff-competencies/:id', requirePermission(MANAGE_COMPETENCIES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_staff_competencies', 'id', [
    'user_id',
    'competency_id',
    'valid_from',
    'valid_to',
    'source_type',
    'comment',
    'is_demo',
    'is_active',
  ], 'Error updating staff clinical competency'));

router.get('/competency-requirements', requirePermission(OPEN_COMPETENCY_REQUIREMENTS), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.*,
        c.competency_code,
        c.competency_name,
        f.factor_code,
        f.factor_name,
        l.level_code,
        l.level_name,
        rs.rule_code,
        rs.rule_name,
        rs.version_number,
        cu.unit_code,
        cu.unit_name,
        dv.division_desc,
        dep.department_desc
      FROM shiftly_schema.clinical_competency_requirements r
      JOIN shiftly_schema.clinical_competencies c ON c.id = r.competency_id
      LEFT JOIN shiftly_schema.clinical_acuity_factors f ON f.id = r.factor_id
      LEFT JOIN shiftly_schema.clinical_acuity_levels l ON l.id = r.acuity_level_id
      LEFT JOIN shiftly_schema.clinical_acuity_rule_sets rs ON rs.id = r.rule_set_id
      LEFT JOIN shiftly_schema.clinical_units cu ON cu.id = r.clinical_unit_id
      LEFT JOIN shiftly_schema.divisions dv ON dv.id = r.division_id
      LEFT JOIN shiftly_schema.departments dep ON dep.id = r.department_id
      ORDER BY r.is_active DESC, r.requirement_source, r.requirement_name, r.id
    `);
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical competency requirements',
    });
  }
});

router.post('/competency-requirements', requirePermission(MANAGE_CAPACITY_POLICIES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_competency_requirements', [
    'requirement_code',
    'requirement_name',
    'requirement_source',
    'competency_id',
    'factor_id',
    'acuity_level_id',
    'rule_set_id',
    'clinical_unit_id',
    'division_id',
    'department_id',
    'minimum_staff_count',
    'effective_start_date',
    'effective_end_date',
    'is_demo',
    'is_active',
  ], 'Error creating clinical competency requirement'));

router.put('/competency-requirements/:id', requirePermission(MANAGE_CAPACITY_POLICIES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_competency_requirements', 'id', [
    'requirement_code',
    'requirement_name',
    'requirement_source',
    'competency_id',
    'factor_id',
    'acuity_level_id',
    'rule_set_id',
    'clinical_unit_id',
    'division_id',
    'department_id',
    'minimum_staff_count',
    'effective_start_date',
    'effective_end_date',
    'is_demo',
    'is_active',
  ], 'Error updating clinical competency requirement'));

router.get('/capacity-policies', requirePermission(OPEN_CAPACITY_POLICIES), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        st.staff_type_name,
        cu.unit_code,
        cu.unit_name,
        dv.division_desc,
        dep.department_desc,
        sh.shift_code,
        sh.shift_label
      FROM shiftly_schema.clinical_capacity_policies p
      LEFT JOIN shiftly_schema.staff_types st ON st.id = p.staff_type_id
      LEFT JOIN shiftly_schema.clinical_units cu ON cu.id = p.clinical_unit_id
      LEFT JOIN shiftly_schema.divisions dv ON dv.id = p.division_id
      LEFT JOIN shiftly_schema.departments dep ON dep.id = p.department_id
      LEFT JOIN shiftly_schema.shift_types sh ON sh.id = p.shift_type_id
      ORDER BY p.is_active DESC, p.policy_name, p.id
    `);
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical capacity policies',
    });
  }
});

router.post('/capacity-policies', requirePermission(MANAGE_CAPACITY_POLICIES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_capacity_policies', [
    'policy_code',
    'policy_name',
    'description',
    'staff_type_id',
    'clinical_unit_id',
    'division_id',
    'department_id',
    'shift_type_id',
    'max_workload',
    'max_patient_count',
    'max_high_acuity_count',
    'max_extreme_acuity_count',
    'effective_start_date',
    'effective_end_date',
    'is_demo',
    'is_active',
  ], 'Error creating clinical capacity policy'));

router.put('/capacity-policies/:id', requirePermission(MANAGE_CAPACITY_POLICIES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_capacity_policies', 'id', [
    'policy_code',
    'policy_name',
    'description',
    'staff_type_id',
    'clinical_unit_id',
    'division_id',
    'department_id',
    'shift_type_id',
    'max_workload',
    'max_patient_count',
    'max_high_acuity_count',
    'max_extreme_acuity_count',
    'effective_start_date',
    'effective_end_date',
    'is_demo',
    'is_active',
  ], 'Error updating clinical capacity policy'));

router.get('/staff-pool', requirePermission(OPEN_STAFF_POOL), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const shiftDate = parseRequiredDate(req.query.shiftDate);
  const shiftTypeId = parseOptionalInt(req.query.shiftTypeId);
  const divisionId = parseOptionalInt(req.query.divisionId);
  const departmentId = parseOptionalInt(req.query.departmentId);
  const clinicalUnitId = parseOptionalInt(req.query.clinicalUnitId);
  if (!shiftDate) {
    return sendApiError(req, res, {
      status: 400,
      error: 'shiftDate must be provided as YYYY-MM-DD.',
      code: 'INVALID_REQUEST',
    });
  }
  if (
    shiftTypeId === undefined ||
    shiftTypeId === null ||
    divisionId === undefined ||
    divisionId === null ||
    departmentId === undefined ||
    departmentId === null
  ) {
    return sendApiError(req, res, {
      status: 400,
      error: 'shiftTypeId, divisionId, and departmentId are required positive integers.',
      code: 'INVALID_REQUEST',
    });
  }
  if (clinicalUnitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'clinicalUnitId must be a positive integer when provided.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM shiftly_api.fn_clinical_staff_pool($1, $2::date, $3, $4, $5, $6)`,
      [userId, shiftDate, shiftTypeId, divisionId, departmentId, clinicalUnitId],
    );
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading eligible clinical staff pool',
    });
  }
});

router.get('/assignment-optimizer-policies', requirePermission(OPEN_ASSIGNMENT_OPTIMIZER_POLICIES), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        cu.unit_code,
        cu.unit_name,
        dv.division_desc,
        dep.department_desc,
        sh.shift_code,
        sh.shift_label
      FROM shiftly_schema.clinical_assignment_optimizer_policies p
      LEFT JOIN shiftly_schema.clinical_units cu ON cu.id = p.clinical_unit_id
      LEFT JOIN shiftly_schema.divisions dv ON dv.id = p.division_id
      LEFT JOIN shiftly_schema.departments dep ON dep.id = p.department_id
      LEFT JOIN shiftly_schema.shift_types sh ON sh.id = p.shift_type_id
      ORDER BY p.is_active DESC, p.policy_name, p.id
    `);
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading assignment optimizer policies',
    });
  }
});

router.post('/assignment-optimizer-policies', requirePermission(PUBLISH_ASSIGNMENTS), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_assignment_optimizer_policies', [
    'policy_code',
    'policy_name',
    'description',
    'clinical_unit_id',
    'division_id',
    'department_id',
    'shift_type_id',
    'effective_start_date',
    'effective_end_date',
    'workload_balance_weight',
    'patient_count_weight',
    'high_extreme_weight',
    'adt_burden_weight',
    'reassignment_penalty',
    'continuity_weight',
    'minimum_rebalance_improvement',
    'maximum_suggested_reassignments',
    'hard_capacity_behavior',
    'imbalance_warning_threshold',
    'is_demo',
    'is_active',
  ], 'Error creating assignment optimizer policy'));

router.put('/assignment-optimizer-policies/:id', requirePermission(PUBLISH_ASSIGNMENTS), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_assignment_optimizer_policies', 'id', [
    'policy_code',
    'policy_name',
    'description',
    'clinical_unit_id',
    'division_id',
    'department_id',
    'shift_type_id',
    'effective_start_date',
    'effective_end_date',
    'workload_balance_weight',
    'patient_count_weight',
    'high_extreme_weight',
    'adt_burden_weight',
    'reassignment_penalty',
    'continuity_weight',
    'minimum_rebalance_improvement',
    'maximum_suggested_reassignments',
    'hard_capacity_behavior',
    'imbalance_warning_threshold',
    'is_demo',
    'is_active',
  ], 'Error updating assignment optimizer policy'));

router.get('/analytics', requirePermission(OPEN_CLINICAL_ANALYTICS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const params = parseAnalyticsParams(req, res);
  if (!params) return null;

  try {
    const result = await pool.query(analyticsSql(), analyticsValues(userId, params));
    return res.json(result.rows[0].report);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading clinical analytics',
    });
  }
});

router.get('/analytics/evidence', requirePermission(OPEN_CLINICAL_ANALYTICS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  const params = parseAnalyticsParams(req, res);
  if (!params) return;
  const metric = String(req.query.metric || '');
  const offsetText = String(req.query.offset ?? '0');
  const offset = Number(offsetText);
  if (!['patient_encounters', 'encounter_count', 'assessment_count', 'average_score', 'average_workload'].includes(metric)
      || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset > 2147483647
      || params.toDate < params.fromDate) {
    return sendApiError(req, res, { status: 400, error: 'Invalid evidence metric, dates or page offset.', code: 'INVALID_REQUEST' });
  }
  try {
    const result = await pool.query(`SELECT shiftly_api.fn_clinical_analytics_evidence(
      $1,$2::date,$3::date,$4,$5,$6,$7,$8,$9) AS evidence`,
      [userId, params.fromDate, params.toDate, params.divisionId, params.departmentId,
        params.clinicalUnitId, params.acuityLevelId, metric, offset]);
    return res.json(result.rows[0].evidence);
  } catch (err) {
    return sendPostgresError(req, res, err, { action: 'GET', label: 'Error loading clinical analytics evidence' });
  }
});

router.get('/analytics/excel', requirePermission(EXPORT_CLINICAL_ANALYTICS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const params = parseAnalyticsParams(req, res);
  if (!params) return null;

  try {
    const result = await pool.query(analyticsSql(), analyticsValues(userId, params));
    const report = result.rows[0].report || {};
    const workbook = buildClinicalAnalyticsWorkbook(report);
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `clinical_analytics_${buildFileStamp()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error exporting clinical analytics Excel report',
    });
  }
});

router.get('/assignment-board/dates', requirePermission(OPEN_ASSIGNMENT_BOARD), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const fromDate = parseRequiredDate(req.query.fromDate || req.query.from_date);
  const toDate = parseRequiredDate(req.query.toDate || req.query.to_date);
  const shiftTypeId = parseOptionalInt(req.query.shiftTypeId || req.query.shift_type_id);
  const clinicalUnitId = parseOptionalInt(req.query.clinicalUnitId || req.query.clinical_unit_id);

  if (!fromDate || !toDate) {
    return sendApiError(req, res, {
      status: 400,
      error: 'fromDate and toDate are required in YYYY-MM-DD format.',
      code: 'INVALID_REQUEST',
    });
  }
  if (fromDate > toDate) {
    return sendApiError(req, res, {
      status: 400,
      error: 'fromDate must be on or before toDate.',
      code: 'INVALID_REQUEST',
    });
  }
  if (shiftTypeId === undefined || clinicalUnitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'Numeric filters must be positive integers when provided.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `
        SELECT
          to_char(sa.shift_date, 'YYYY-MM-DD') AS shift_date,
          sa.shift_type_id,
          cu.id AS clinical_unit_id
        FROM shiftly_schema.clinical_units cu
        JOIN shiftly_schema.shift_assignments sa
          ON (sa.division_id IS NULL OR sa.division_id = cu.division_id)
         AND sa.department_id = cu.department_id
        JOIN shiftly_schema.users u ON u.id = sa.user_id
        WHERE cu.is_active = true
          AND sa.shift_date BETWEEN $2::date AND $3::date
          AND ($4::integer IS NULL OR sa.shift_type_id = $4)
          AND ($5::integer IS NULL OR cu.id = $5)
          AND sa.status <> 'CANCELLED'
          AND COALESCE(sa.is_absence, 2) <> 1
          AND shiftly_api.fn_user_can_access_division_department($1, cu.division_id, cu.department_id)
        GROUP BY sa.shift_date, sa.shift_type_id, cu.id
        ORDER BY sa.shift_date ASC, sa.shift_type_id ASC, cu.id ASC
      `,
      [userId, fromDate, toDate, shiftTypeId, clinicalUnitId],
    );

    const dates = [
      ...new Set(result.rows.map((row) => row.shift_date)),
    ];

    return res.json({
      from_date: fromDate,
      to_date: toDate,
      shift_type_id: shiftTypeId,
      clinical_unit_id: clinicalUnitId,
      dates,
      availability: result.rows,
    });
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical assignment board dates',
    });
  }
});

router.get('/assignment-board', requirePermission(OPEN_ASSIGNMENT_BOARD), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const shiftDate = parseRequiredDate(req.query.shiftDate);
  const shiftTypeId = parseOptionalInt(req.query.shiftTypeId);
  const divisionId = parseOptionalInt(req.query.divisionId);
  const departmentId = parseOptionalInt(req.query.departmentId);
  const clinicalUnitId = parseOptionalInt(req.query.clinicalUnitId);
  if (!shiftDate || shiftTypeId == null || divisionId == null || departmentId == null) {
    return sendApiError(req, res, {
      status: 400,
      error: 'shiftDate, shiftTypeId, divisionId, and departmentId are required.',
      code: 'INVALID_REQUEST',
    });
  }
  if (shiftTypeId === undefined || divisionId === undefined || departmentId === undefined || clinicalUnitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'Numeric filters must be positive integers when provided.',
      code: 'INVALID_REQUEST',
    });
  }
  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_assignment_board($1, $2::date, $3, $4, $5, $6) AS board`,
      [userId, shiftDate, shiftTypeId, divisionId, departmentId, clinicalUnitId],
    );
    return res.json(result.rows[0].board);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading clinical assignment board',
    });
  }
});

router.get('/assignment-history', requirePermission(OPEN_ASSIGNMENT_BOARD), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }
  const shiftDate = parseRequiredDate(req.query.shiftDate);
  const shiftTypeId = parseOptionalInt(req.query.shiftTypeId);
  const divisionId = parseOptionalInt(req.query.divisionId);
  const departmentId = parseOptionalInt(req.query.departmentId);
  const clinicalUnitId = parseOptionalInt(req.query.clinicalUnitId);
  if (!shiftDate || shiftTypeId == null || divisionId == null || departmentId == null) {
    return sendApiError(req, res, {
      status: 400,
      error: 'shiftDate, shiftTypeId, divisionId, and departmentId are required.',
      code: 'INVALID_REQUEST',
    });
  }
  if (shiftTypeId === undefined || divisionId === undefined || departmentId === undefined || clinicalUnitId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'Numeric filters must be positive integers when provided.',
      code: 'INVALID_REQUEST',
    });
  }
  try {
    const result = await pool.query(
      `
        SELECT
          h.id,
          h.assignment_id,
          h.optimization_run_id,
          r.run_number,
          r.optimization_mode,
          r.optimization_status,
          h.change_type,
          h.change_reason,
          p.display_name AS patient_name,
          p.patient_public_id,
          cu.unit_name,
          to_char(COALESCE(nsa.shift_date, psa.shift_date, r.shift_date), 'YYYY-MM-DD') AS shift_date,
          COALESCE(nst.shift_label, pst.shift_label, rst.shift_label) AS shift_label,
          to_char(COALESCE(nsa.start_time, psa.start_time), 'HH24:MI') AS shift_start_time,
          to_char(COALESCE(nsa.end_time, psa.end_time), 'HH24:MI') AS shift_end_time,
          pu.user_desc AS previous_user_name,
          nu.user_desc AS new_user_name,
          h.previous_shift_assignment_id,
          h.new_shift_assignment_id,
          COALESCE(actor.user_desc, 'Unknown') AS changed_by_name,
          shiftly_api.fn_clinical_action_metadata(to_jsonb(h))->>'source' AS source,
          shiftly_api.fn_clinical_action_metadata(to_jsonb(h))->>'action_by' AS action_by,
          shiftly_api.fn_clinical_action_metadata(to_jsonb(h))->>'action_date_time' AS action_date_time,
          to_char(h.changed_at, 'YYYY-MM-DD HH24:MI:SS') AS changed_at,
          EXISTS (
            SELECT 1
            FROM shiftly_schema.clinical_patient_assignments pa
            WHERE pa.id = h.assignment_id
              AND pa.assignment_status = 'PUBLISHED'
              AND pa.ended_at IS NULL
          ) AS is_current_published
        FROM shiftly_schema.clinical_patient_assignment_history h
        JOIN shiftly_schema.clinical_encounters e ON e.id = h.encounter_id
        JOIN shiftly_schema.clinical_patients p ON p.id = h.patient_id
        JOIN shiftly_schema.clinical_units cu ON cu.id = e.current_clinical_unit_id
        LEFT JOIN shiftly_schema.clinical_assignment_optimization_runs r ON r.id = h.optimization_run_id
        LEFT JOIN shiftly_schema.shift_assignments nsa ON nsa.id = h.new_shift_assignment_id
        LEFT JOIN shiftly_schema.shift_types nst ON nst.id = nsa.shift_type_id
        LEFT JOIN shiftly_schema.shift_assignments psa ON psa.id = h.previous_shift_assignment_id
        LEFT JOIN shiftly_schema.shift_types pst ON pst.id = psa.shift_type_id
        LEFT JOIN shiftly_schema.shift_types rst ON rst.id = r.shift_type_id
        LEFT JOIN shiftly_schema.users pu ON pu.id = h.previous_assigned_user_id
        LEFT JOIN shiftly_schema.users nu ON nu.id = h.new_assigned_user_id
        LEFT JOIN shiftly_schema.users actor ON actor.id = h.changed_by
        WHERE e.division_id = $3
          AND e.department_id = $4
          AND ($5::integer IS NULL OR e.current_clinical_unit_id = $5)
          AND shiftly_api.fn_user_can_access_division_department($1, e.division_id, e.department_id)
          AND COALESCE(nsa.shift_date, psa.shift_date, r.shift_date) = $2::date
          AND COALESCE(nsa.shift_type_id, psa.shift_type_id, r.shift_type_id) = $6
        ORDER BY h.changed_at DESC, h.id DESC
        LIMIT 250
      `,
      [userId, shiftDate, divisionId, departmentId, clinicalUnitId, shiftTypeId],
    );
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical assignment history',
    });
  }
});

router.get('/assignment-workflows/:id/details', requirePermission(OPEN_ASSIGNMENT_BOARD), async (req, res) => {
  const userId = actorUserId(req);
  const workflowId = requirePositiveId(req, res, req.params.id, 'id');
  if (!userId) return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  if (!workflowId) return null;
  try {
    const result = await pool.query('SELECT shiftly_api.fn_clinical_assignment_attention_details($1, $2) AS detail', [userId, workflowId]);
    return res.json(describeClinicalAttention(result.rows[0].detail));
  } catch (err) {
    return sendPostgresError(req, res, err, { action: 'GET', label: 'Error loading clinical assignment attention details' });
  }
});

router.get('/assignment-workflows', requirePermission(OPEN_ASSIGNMENT_BOARD), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  const status = req.query.status == null || `${req.query.status}`.trim() === ''
    ? null
    : `${req.query.status}`.trim().toUpperCase();
  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_assignment_workflows($1, $2) AS workflows`,
      [userId, status],
    );
    return res.json(result.rows[0].workflows || []);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading clinical assignment workflows',
    });
  }
});

router.get('/shift-context/:shiftAssignmentId', requireAnyClinicalPermission([OPEN_ASSIGNMENT_BOARD, OPEN_MOBILE_PATIENTS]), async (req, res) => {
  const userId = actorUserId(req);
  const shiftAssignmentId = requirePositiveId(req, res, req.params.shiftAssignmentId, 'shiftAssignmentId');
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!shiftAssignmentId) return null;
  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_shift_context_summary($1, $2) AS summary`,
      [userId, shiftAssignmentId],
    );
    return res.json(result.rows[0].summary || {});
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading clinical shift context',
    });
  }
});

router.post('/assignment-workflows/evaluate', requirePermission(REVIEW_ASSIGNMENT_WORKFLOWS), async (req, res) => {
  const userId = actorUserId(req);
  const shiftDate = parseRequiredDate(req.body?.shift_date);
  const shiftTypeId = parseOptionalInt(req.body?.shift_type_id);
  const divisionId = parseOptionalInt(req.body?.division_id);
  const departmentId = parseOptionalInt(req.body?.department_id);
  const clinicalUnitId = parseOptionalInt(req.body?.clinical_unit_id);
  const triggerType = String(req.body?.trigger_type || 'ACTIVE_REEVALUATION').trim().toUpperCase();
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!shiftDate || shiftTypeId == null || divisionId == null || departmentId == null) {
    return sendApiError(req, res, {
      status: 400,
      error: 'shift_date, shift_type_id, division_id, and department_id are required.',
      code: 'INVALID_REQUEST',
    });
  }
  if (shiftTypeId === undefined || divisionId === undefined || departmentId === undefined || clinicalUnitId === undefined) {
    return sendApiError(req, res, { status: 400, error: 'Numeric filters must be positive integers when provided.', code: 'INVALID_REQUEST' });
  }
  try {
    if (!(await ensureClinicalAssignmentDateEditable(req, res, shiftDate))) return null;

    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_evaluate_assignment_review($1, $2::date, $3, $4, $5, $6, $7, 'MANUAL') AS result`,
      [userId, shiftDate, shiftTypeId, divisionId, departmentId, clinicalUnitId, triggerType],
    );
    return res.status(201).json(result.rows[0].result);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error evaluating clinical assignment review',
    });
  }
});

router.post('/assignment-workflows/:id/review', requirePermission(REVIEW_ASSIGNMENT_WORKFLOWS), async (req, res) => {
  const userId = actorUserId(req);
  const workflowId = requirePositiveId(req, res, req.params.id, 'id');
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!workflowId) return null;
  try {
    if (!(await ensureClinicalAssignmentWorkflowDateEditable(req, res, workflowId))) return null;

    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_mark_assignment_workflow_reviewed($1, $2) AS workflows`,
      [userId, workflowId],
    );
    return res.json(result.rows[0].workflows || []);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error reviewing clinical assignment workflow',
    });
  }
});

router.post('/assignment-workflows/:id/optimize', requirePermission(OPTIMIZE_ASSIGNMENTS), async (req, res) => {
  const userId = actorUserId(req);
  const workflowId = requirePositiveId(req, res, req.params.id, 'id');
  const mode = String(req.body?.optimization_mode || 'REBALANCE').trim().toUpperCase();
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!workflowId) return null;
  if (!['INITIAL_ASSIGNMENT', 'REBALANCE'].includes(mode)) {
    return sendApiError(req, res, {
      status: 400,
      error: 'optimization_mode must be INITIAL_ASSIGNMENT or REBALANCE.',
      code: 'INVALID_REQUEST',
    });
  }
  try {
    if (!(await ensureClinicalAssignmentWorkflowDateEditable(req, res, workflowId))) return null;

    const result = await pool.serializableQuery(
      `SELECT shiftly_api.fn_clinical_request_assignment_workflow_optimization($1, $2, $3) AS workflows`,
      [userId, workflowId, mode],
    );
    return res.status(201).json(result.rows[0].workflows || []);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error requesting clinical assignment optimization',
    });
  }
});

router.post('/assignment-workflows/:id/skip', requirePermission(REVIEW_ASSIGNMENT_WORKFLOWS), async (req, res) => {
  const userId = actorUserId(req);
  const workflowId = requirePositiveId(req, res, req.params.id, 'id');
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!workflowId) return null;
  try {
    if (!(await ensureClinicalAssignmentWorkflowDateEditable(req, res, workflowId))) return null;

    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_skip_assignment_workflow($1, $2, $3) AS workflows`,
      [userId, workflowId, req.body?.reason ?? null],
    );
    return res.json(result.rows[0].workflows || []);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error skipping clinical assignment workflow',
    });
  }
});

router.post('/assignment-runs/generate', requirePermission(OPTIMIZE_ASSIGNMENTS), async (req, res) => {
  const userId = actorUserId(req);
  const shiftDate = parseRequiredDate(req.body?.shift_date);
  const shiftTypeId = parseOptionalInt(req.body?.shift_type_id);
  const divisionId = parseOptionalInt(req.body?.division_id);
  const departmentId = parseOptionalInt(req.body?.department_id);
  const clinicalUnitId = parseOptionalInt(req.body?.clinical_unit_id);
  const mode = String(req.body?.optimization_mode || '').trim().toUpperCase();
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!shiftDate || shiftTypeId == null || divisionId == null || departmentId == null || !['INITIAL_ASSIGNMENT', 'REBALANCE'].includes(mode)) {
    return sendApiError(req, res, {
      status: 400,
      error: 'shift_date, shift_type_id, division_id, department_id, and valid optimization_mode are required.',
      code: 'INVALID_REQUEST',
    });
  }
  if (shiftTypeId === undefined || divisionId === undefined || departmentId === undefined || clinicalUnitId === undefined) {
    return sendApiError(req, res, { status: 400, error: 'Numeric filters must be positive integers when provided.', code: 'INVALID_REQUEST' });
  }
  try {
    if (!(await ensureClinicalAssignmentDateEditable(req, res, shiftDate))) return null;

    const result = await pool.serializableQuery(
      `SELECT shiftly_api.fn_clinical_generate_assignment_run($1, $2::date, $3, $4, $5, $6, $7) AS run`,
      [userId, shiftDate, shiftTypeId, divisionId, departmentId, clinicalUnitId, mode],
    );
    return res.status(201).json(result.rows[0].run);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error generating clinical assignment optimization',
    });
  }
});

router.post('/assignment-runs/:id/manual-override', requirePermission(OVERRIDE_ASSIGNMENTS), async (req, res) => {
  const userId = actorUserId(req);
  const runId = requirePositiveId(req, res, req.params.id, 'id');
  const encounterId = parseOptionalInt(req.body?.encounter_id);
  const shiftAssignmentId = parseOptionalInt(req.body?.shift_assignment_id);
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!runId) return null;
  if (encounterId === undefined || encounterId === null || shiftAssignmentId === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'encounter_id is required and shift_assignment_id must be a positive integer when provided.',
      code: 'INVALID_REQUEST',
    });
  }
  try {
    if (!(await ensureClinicalAssignmentRunDateEditable(req, res, runId))) return null;

    const runStatus = await pool.query(
      `
        SELECT optimization_status
        FROM shiftly_schema.clinical_assignment_optimization_runs
        WHERE id = $1
      `,
      [runId],
    );
    if (!runStatus.rows.length) {
      return sendApiError(req, res, {
        status: 404,
        error: 'Assignment draft was not found.',
        code: 'CLINICAL_RUN_NOT_FOUND',
      });
    }
    if (!['GENERATED', 'REVIEWED'].includes(runStatus.rows[0].optimization_status)) {
      return sendApiError(req, res, {
        status: 409,
        error: 'Manual changes are available only while reviewing a draft assignment. Generate a rebalance proposal before changing a published assignment.',
        code: 'CLINICAL_RUN_NOT_EDITABLE',
      });
    }
    const result = await pool.serializableQuery(
      `SELECT shiftly_api.fn_clinical_manual_assignment_override($1, $2, $3, $4, $5) AS run`,
      [userId, runId, encounterId, shiftAssignmentId, req.body?.note ?? null],
    );
    return res.json(result.rows[0].run);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error applying manual assignment override',
    });
  }
});

router.post('/assignment-runs/:id/publish', requirePermission(PUBLISH_ASSIGNMENTS), async (req, res) => {
  const userId = actorUserId(req);
  const runId = requirePositiveId(req, res, req.params.id, 'id');
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!runId) return null;
  try {
    if (!(await ensureClinicalAssignmentRunDateEditable(req, res, runId))) return null;

    const result = await pool.serializableQuery(
      `SELECT shiftly_api.fn_clinical_publish_assignment_run($1, $2) AS run`,
      [userId, runId],
    );
    return res.json(result.rows[0].run);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error publishing clinical assignment run',
    });
  }
});

router.post('/assignment-runs/:id/cancel', requirePermission(PUBLISH_ASSIGNMENTS), async (req, res) => {
  const userId = actorUserId(req);
  const runId = requirePositiveId(req, res, req.params.id, 'id');
  if (!userId) {
    return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  }
  if (!runId) return null;
  try {
    if (!(await ensureClinicalAssignmentRunDateEditable(req, res, runId))) return null;

    const result = await pool.query(
      `SELECT shiftly_api.fn_clinical_cancel_assignment_run($1, $2, $3) AS run`,
      [userId, runId, req.body?.reason ?? null],
    );
    return res.json(result.rows[0].run);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error cancelling clinical assignment run',
    });
  }
});

router.get('/mobile/my-patients', requirePermission(OPEN_MOBILE_PATIENTS), async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  try {
    const scope = String(req.query.scope || 'CURRENT').trim().toUpperCase();
    const shiftAssignmentId = parseOptionalInt(req.query.shiftAssignmentId || req.query.shift_assignment_id);
    if (!['CURRENT', 'HISTORY', 'ALL'].includes(scope)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'scope must be CURRENT, HISTORY, or ALL.',
        code: 'INVALID_REQUEST',
      });
    }
    if (shiftAssignmentId === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'shiftAssignmentId must be a positive integer when provided.',
        code: 'INVALID_REQUEST',
      });
    }

    const result = await pool.query(
      `SELECT p.*, shiftly_api.fn_clinical_action_metadata(to_jsonb(pa)) AS assignment_action
       FROM shiftly_api.fn_clinical_mobile_my_patients($1, $2, $3) p
       LEFT JOIN shiftly_schema.clinical_patient_assignments pa ON pa.id=p.assignment_id`,
      [userId, scope, shiftAssignmentId],
    );
    return res.json(result.rows);
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'LIST',
      label: 'Error loading mobile assigned patients',
    });
  }
});

router.get(
  '/acuity/rule-sets',
  requirePermission(OPEN_ACUITY_RULE_SETS),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          rs.*,
          cu.unit_name AS clinical_unit_name,
          dv.division_desc,
          dep.department_desc,
          (
            SELECT COUNT(*)
            FROM shiftly_schema.clinical_acuity_assessments a
            WHERE a.rule_set_id = rs.id
          ) AS assessment_count
        FROM shiftly_schema.clinical_acuity_rule_sets rs
        LEFT JOIN shiftly_schema.clinical_units cu ON cu.id = rs.clinical_unit_id
        LEFT JOIN shiftly_schema.divisions dv ON dv.id = rs.division_id
        LEFT JOIN shiftly_schema.departments dep ON dep.id = rs.department_id
        ORDER BY rs.is_active DESC, rs.rule_code ASC, rs.version_number DESC, rs.id DESC
      `);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading acuity rule sets',
      });
    }
  },
);

router.post(
  '/acuity/rule-sets',
  requirePermission(MANAGE_ACUITY_RULES),
  async (req, res) => {
    const body = pickBody(req, [
      'rule_code',
      'rule_name',
      'description',
      'version_number',
      'previous_rule_set_id',
      'effective_start_at',
      'effective_end_at',
      'status',
      'clinical_unit_id',
      'division_id',
      'department_id',
      'is_demo',
      'is_active',
    ]);
    const userId = actorUserId(req);
    body.created_by = userId;
    body.updated_by = userId;
    if (String(body.status || '').toUpperCase() === 'PUBLISHED') {
      return sendApiError(req, res, {
        status: 400,
        error: 'Use the publish action to publish an acuity rule set.',
        code: 'INVALID_REQUEST',
      });
    }
    req.body = body;
    return insertRow(
      req,
      res,
      'shiftly_schema.clinical_acuity_rule_sets',
      Object.keys(body),
      'Error creating acuity rule set',
    );
  },
);

router.put(
  '/acuity/rule-sets/:id',
  requirePermission(MANAGE_ACUITY_RULES),
  async (req, res) => {
    const body = pickBody(req, [
      'rule_code',
      'rule_name',
      'description',
      'version_number',
      'previous_rule_set_id',
      'effective_start_at',
      'effective_end_at',
      'status',
      'clinical_unit_id',
      'division_id',
      'department_id',
      'is_demo',
      'is_active',
    ]);
    body.updated_by = actorUserId(req);
    if (String(body.status || '').toUpperCase() === 'PUBLISHED') {
      return sendApiError(req, res, {
        status: 400,
        error: 'Use the publish action to publish an acuity rule set.',
        code: 'INVALID_REQUEST',
      });
    }
    req.body = body;
    return updateRow(
      req,
      res,
      'shiftly_schema.clinical_acuity_rule_sets',
      'id',
      Object.keys(body),
      'Error updating acuity rule set',
    );
  },
);

router.post(
  '/acuity/rule-sets/:id/publish',
  requirePermission(MANAGE_ACUITY_RULES),
  async (req, res) => {
    const id = requirePositiveId(req, res, req.params.id, 'id');
    if (!id) return null;
    try {
      const result = await pool.query(
        `SELECT * FROM shiftly_api.fn_clinical_publish_rule_set($1, $2)`,
        [id, actorUserId(req)],
      );
      return res.json(result.rows[0]);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'UPDATE',
        label: 'Error publishing acuity rule set',
      });
    }
  },
);

router.get(
  '/acuity/levels',
  requirePermission(OPEN_ACUITY_LEVELS),
  async (req, res) => {
    const ruleSetId = parseOptionalInt(req.query.ruleSetId);
    if (ruleSetId === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'ruleSetId must be a positive integer when provided.',
        code: 'INVALID_REQUEST',
      });
    }
    try {
      const params = [];
      const where = ruleSetId == null ? '' : 'WHERE l.rule_set_id = $1';
      if (ruleSetId != null) params.push(ruleSetId);
      const result = await pool.query(`
        SELECT l.*, rs.rule_code, rs.rule_name, rs.version_number
        FROM shiftly_schema.clinical_acuity_levels l
        JOIN shiftly_schema.clinical_acuity_rule_sets rs ON rs.id = l.rule_set_id
        ${where}
        ORDER BY rs.rule_code, rs.version_number DESC, l.display_order, l.min_score, l.id
      `, params);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading acuity levels',
      });
    }
  },
);

router.post('/acuity/levels', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_acuity_levels', [
    'rule_set_id',
    'level_code',
    'level_name',
    'description',
    'min_score',
    'max_score',
    'workload_weight',
    'color_hex',
    'display_order',
    'is_active',
  ], 'Error creating acuity level'));

router.put('/acuity/levels/:id', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_acuity_levels', 'id', [
    'level_code',
    'level_name',
    'description',
    'min_score',
    'max_score',
    'workload_weight',
    'color_hex',
    'display_order',
    'is_active',
  ], 'Error updating acuity level'));

router.get(
  '/acuity/factor-categories',
  requirePermission(OPEN_ACUITY_FACTORS),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT *
        FROM shiftly_schema.clinical_acuity_factor_categories
        ORDER BY is_active DESC, display_order, category_name, id
      `);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading acuity factor categories',
      });
    }
  },
);

router.post('/acuity/factor-categories', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_acuity_factor_categories', [
    'category_code',
    'category_name',
    'description',
    'display_order',
    'is_active',
  ], 'Error creating acuity factor category'));

router.put('/acuity/factor-categories/:id', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_acuity_factor_categories', 'id', [
    'category_code',
    'category_name',
    'description',
    'display_order',
    'is_active',
  ], 'Error updating acuity factor category'));

router.get(
  '/acuity/factors',
  requirePermission(OPEN_ACUITY_FACTORS),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT f.*, c.category_code, c.category_name
        FROM shiftly_schema.clinical_acuity_factors f
        JOIN shiftly_schema.clinical_acuity_factor_categories c ON c.id = f.category_id
        ORDER BY f.is_active DESC, c.display_order, f.display_order, f.factor_name, f.id
      `);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading acuity factors',
      });
    }
  },
);

router.post('/acuity/factors', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_acuity_factors', [
    'factor_code',
    'factor_name',
    'category_id',
    'description',
    'score_weight',
    'workload_weight',
    'can_trigger_competency',
    'display_order',
    'effective_start_at',
    'effective_end_at',
    'is_demo',
    'is_active',
  ], 'Error creating acuity factor'));

router.put('/acuity/factors/:id', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_acuity_factors', 'id', [
    'factor_code',
    'factor_name',
    'category_id',
    'description',
    'score_weight',
    'workload_weight',
    'can_trigger_competency',
    'display_order',
    'effective_start_at',
    'effective_end_at',
    'is_demo',
    'is_active',
  ], 'Error updating acuity factor'));

router.get(
  '/acuity/rule-set-factors',
  requirePermission(OPEN_ACUITY_FACTORS),
  async (req, res) => {
    const ruleSetId = parseOptionalInt(req.query.ruleSetId);
    if (ruleSetId === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'ruleSetId must be a positive integer when provided.',
        code: 'INVALID_REQUEST',
      });
    }
    try {
      const params = [];
      const where = ruleSetId == null ? '' : 'WHERE rsf.rule_set_id = $1';
      if (ruleSetId != null) params.push(ruleSetId);
      const result = await pool.query(`
        SELECT
          rsf.*,
          f.factor_code,
          f.factor_name,
          c.category_name,
          rs.rule_code,
          rs.rule_name,
          rs.version_number
        FROM shiftly_schema.clinical_acuity_rule_set_factors rsf
        JOIN shiftly_schema.clinical_acuity_rule_sets rs ON rs.id = rsf.rule_set_id
        JOIN shiftly_schema.clinical_acuity_factors f ON f.id = rsf.factor_id
        JOIN shiftly_schema.clinical_acuity_factor_categories c ON c.id = f.category_id
        ${where}
        ORDER BY rs.rule_code, rs.version_number DESC, c.display_order, f.display_order, f.factor_name
      `, params);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading rule set factors',
      });
    }
  },
);

router.post('/acuity/rule-set-factors', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_acuity_rule_set_factors', [
    'rule_set_id',
    'factor_id',
    'score_weight_override',
    'workload_weight_override',
    'is_required',
    'is_active',
  ], 'Error creating rule set factor'));

router.put('/acuity/rule-set-factors/:id', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_acuity_rule_set_factors', 'id', [
    'score_weight_override',
    'workload_weight_override',
    'is_required',
    'is_active',
  ], 'Error updating rule set factor'));

router.get(
  '/acuity/adt-event-types',
  requirePermission(OPEN_FLOW_RULES),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT *
        FROM shiftly_schema.clinical_adt_event_types
        ORDER BY is_active DESC, display_order, event_name, id
      `);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading ADT event types',
      });
    }
  },
);

router.post('/acuity/adt-event-types', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_adt_event_types', [
    'event_code',
    'event_name',
    'description',
    'score_weight',
    'workload_weight',
    'display_order',
    'is_demo',
    'is_active',
  ], 'Error creating ADT event type'));

router.put('/acuity/adt-event-types/:id', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_adt_event_types', 'id', [
    'event_code',
    'event_name',
    'description',
    'score_weight',
    'workload_weight',
    'display_order',
    'is_demo',
    'is_active',
  ], 'Error updating ADT event type'));

router.get(
  '/acuity/flow-rules',
  requirePermission(OPEN_FLOW_RULES),
  async (req, res) => {
    const ruleSetId = parseOptionalInt(req.query.ruleSetId);
    if (ruleSetId === undefined) {
      return sendApiError(req, res, {
        status: 400,
        error: 'ruleSetId must be a positive integer when provided.',
        code: 'INVALID_REQUEST',
      });
    }
    try {
      const params = [];
      const where = ruleSetId == null ? '' : 'WHERE r.rule_set_id = $1';
      if (ruleSetId != null) params.push(ruleSetId);
      const result = await pool.query(`
        SELECT
          r.*,
          et.event_code,
          et.event_name,
          rs.rule_code,
          rs.rule_name,
          rs.version_number
        FROM shiftly_schema.clinical_acuity_rule_set_adt_rules r
        JOIN shiftly_schema.clinical_adt_event_types et ON et.id = r.event_type_id
        JOIN shiftly_schema.clinical_acuity_rule_sets rs ON rs.id = r.rule_set_id
        ${where}
        ORDER BY rs.rule_code, rs.version_number DESC, et.display_order, et.event_name
      `, params);
      return res.json(result.rows);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error loading ADT flow rules',
      });
    }
  },
);

router.post('/acuity/flow-rules', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  insertRow(req, res, 'shiftly_schema.clinical_acuity_rule_set_adt_rules', [
    'rule_set_id',
    'event_type_id',
    'score_weight_override',
    'workload_weight_override',
    'lookback_hours',
    'is_active',
  ], 'Error creating ADT flow rule'));

router.put('/acuity/flow-rules/:id', requirePermission(MANAGE_ACUITY_RULES), (req, res) =>
  updateRow(req, res, 'shiftly_schema.clinical_acuity_rule_set_adt_rules', 'id', [
    'score_weight_override',
    'workload_weight_override',
    'lookback_hours',
    'is_active',
  ], 'Error updating ADT flow rule'));

router.post(
  '/acuity/encounters/:encounterId/calculate',
  requirePermission(MANAGE_ACUITY_RULES),
  async (req, res) => {
    const encounterId = requirePositiveId(
      req,
      res,
      req.params.encounterId,
      'encounterId',
    );
    if (!encounterId) return null;
    const sourceType = String(req.body?.source_type || 'MANUAL').trim().toUpperCase();
    try {
      const result = await pool.query(
        `SELECT * FROM shiftly_api.fn_clinical_calculate_acuity($1, $2, $3, CURRENT_TIMESTAMP::timestamp without time zone)`,
        [encounterId, sourceType, actorUserId(req)],
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      return sendPostgresError(req, res, err, {
        action: 'CREATE',
        label: 'Error calculating clinical acuity',
      });
    }
  },
);

module.exports = router;
