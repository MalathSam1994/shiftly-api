const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');

const router = express.Router();

function sendDbError(res, err, context) {
  const payload = {
    error: 'Database error',
    context: context || undefined,
    message: err?.message,
    code: err?.code,
    detail: err?.detail,
    constraint: err?.constraint,
    table: err?.table,
    column: err?.column,
    schema: err?.schema,
    routine: err?.routine,
    where: err?.where,
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] == null) delete payload[key];
  });

  return res.status(500).json(payload);
}

function asIntOrNull(value) {
  if (value == null) return null;

  const text = String(value).trim();
  if (!text) return null;

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asStringOrNull(value) {
  if (value == null) return null;

  const text = String(value).trim();
  return text ? text : null;
}

function asDateStringOrNull(value) {
  if (value == null) return null;

  const text = String(value).trim();
  if (!text) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  return text;
}

function getLoggedUserId(req) {
  const requestedLoggedUserId = asIntOrNull(req.query.loggedUserId);
  const authenticatedUserId =
    asIntOrNull(req.user?.id) ||
    asIntOrNull(req.user?.user_id) ||
    asIntOrNull(req.auth?.id) ||
    asIntOrNull(req.auth?.user_id);

  return authenticatedUserId || requestedLoggedUserId;
}

function getSearchParams(req) {
  return {
    loggedUserId: getLoggedUserId(req),
    from: asDateStringOrNull(req.query.from),
    to: asDateStringOrNull(req.query.to),
    divisionId: asIntOrNull(req.query.divisionId),
    departmentId: asIntOrNull(req.query.departmentId),
    staffTypeId: asIntOrNull(req.query.staffTypeId),
    shiftTypeId: asIntOrNull(req.query.shiftTypeId),
    userId: asIntOrNull(req.query.userId),
    status: asStringOrNull(req.query.status),
    groupBy: asStringOrNull(req.query.groupBy) || 'department',
  };
}

function buildSearchSql() {
  return `
    SELECT
      shift_assignment_id,
      shift_period_id,
      to_char(shift_date, 'YYYY-MM-DD') AS shift_date,
      user_id,
      user_name,
      user_desc,
      empno,
      staff_type_id,
      staff_type_name,
      division_id,
      division_desc,
      department_id,
      department_desc,
      shift_type_id,
      shift_code,
      shift_label,
      start_time,
      end_time,
      duration_hours,
      status,
      source_type,
      is_absence,
      absence_type,
      can_include_all_shifts,
      data_scope
    FROM shiftly_api.fn_desktop_shift_matrix_search(
      $1::integer,
      $2::date,
      $3::date,
      $4::integer,
      $5::integer,
      $6::integer,
      $7::integer,
      $8::integer,
      $9::character varying
    )
  `;
}

function buildSearchValues(params) {
  return [
    params.loggedUserId,
    params.from,
    params.to,
    params.divisionId,
    params.departmentId,
    params.staffTypeId,
    params.shiftTypeId,
    params.userId,
    params.status,
  ];
}

function validateRequiredSearchParams(res, params) {
  if (!params.loggedUserId || !params.from || !params.to) {
    res.status(400).json({
      error: 'Missing required query params',
      required: ['loggedUserId', 'from', 'to'],
      example:
        '/desktop-search/shift-matrix?loggedUserId=2&from=2026-05-01&to=2026-06-01',
    });
    return false;
  }

  return true;
}

function hhMm(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  return text.length >= 5 ? text.substring(0, 5) : text;
}

function displayUser(row) {
  const name = row.user_desc || row.user_name || `User ${row.user_id}`;
  return row.empno ? `${name} (${row.empno})` : name;
}

function displayShift(row) {
  const label = row.shift_label || '';
  const code = row.shift_code || '';

  if (label && code) return `${label} (${code})`;
  if (label) return label;
  if (code) return code;
  if (row.shift_type_id) return `Shift ${row.shift_type_id}`;

  return 'Shift';
}

function displayDuration(value) {
  if (value == null || value === '') return '';

  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);

  if (Number.isInteger(n)) return `${n}h`;
  return `${n.toFixed(2)}h`;
}

function displayTimeRange(row) {
  const start = hhMm(row.start_time);
  const end = hhMm(row.end_time);
  if (!start || !end) return '';
  return `${start} - ${end}`;
}

function groupTitle(row, groupBy) {
  switch ((groupBy || '').trim()) {
    case 'division':
      return row.division_desc || `Division ${row.division_id ?? '-'}`;
    case 'staffType':
      return row.staff_type_name || `Staff type ${row.staff_type_id ?? '-'}`;
    case 'shiftType':
      return displayShift(row);
    case 'department':
    default:
      return row.department_desc || `Department ${row.department_id ?? '-'}`;
  }
}

function groupByLabel(groupBy) {
  switch ((groupBy || '').trim()) {
    case 'division':
      return 'Division';
    case 'staffType':
      return 'Staff type';
    case 'shiftType':
      return 'Shift type';
    case 'department':
    default:
      return 'Department';
  }
}

function safeSheetName(name) {
  return String(name || 'Shift Matrix')
    .replace(/[\\/*?:[\]]/g, ' ')
    .substring(0, 31)
    .trim() || 'Shift Matrix';
}

function buildFileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

router.get('/excel', async (req, res) => {
  const params = getSearchParams(req);

  if (!validateRequiredSearchParams(res, params)) return;

  try {
    const { rows } = await pool.query(buildSearchSql(), buildSearchValues(params));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Shiftly';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet(safeSheetName('Shift Matrix'));

    worksheet.addRow(['Shift Matrix Report']);
    worksheet.addRow(['From', params.from]);
    worksheet.addRow(['To exclusive', params.to]);
    worksheet.addRow(['Grouped by', groupByLabel(params.groupBy)]);
    worksheet.addRow([
      'Data scope',
      rows.length > 0 ? rows[0].data_scope : '',
    ]);
    worksheet.addRow([
      'Can include all shifts',
      rows.length > 0 ? String(rows[0].can_include_all_shifts) : '',
    ]);
    worksheet.addRow(['Rows', rows.length]);
    worksheet.addRow([]);

    worksheet.mergeCells('A1:J1');
    worksheet.getCell('A1').font = { bold: true, size: 16 };
    worksheet.getCell('A1').alignment = { horizontal: 'center' };

    for (let rowNumber = 2; rowNumber <= 7; rowNumber += 1) {
      worksheet.getCell(`A${rowNumber}`).font = { bold: true };
    }

    const headerRow = worksheet.addRow([
      groupByLabel(params.groupBy),
      'User',
      'Date',
      'Shift',
      'Time',
      'Duration',
      'Division',
      'Department',
      'Staff type',
      'Status',
      'Source',
      'Absence',
      'Assignment ID',
      'Shift period ID',
    ]);

    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle' };

    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      };
    });

    const sortedRows = [...rows].sort((a, b) => {
      const groupCompare = groupTitle(a, params.groupBy).localeCompare(
        groupTitle(b, params.groupBy),
        undefined,
        { sensitivity: 'base' },
      );
      if (groupCompare !== 0) return groupCompare;

      const userCompare = displayUser(a).localeCompare(displayUser(b), undefined, {
        sensitivity: 'base',
      });
      if (userCompare !== 0) return userCompare;

      const dateCompare = String(a.shift_date || '').localeCompare(
        String(b.shift_date || ''),
      );
      if (dateCompare !== 0) return dateCompare;

      return hhMm(a.start_time).localeCompare(hhMm(b.start_time));
    });

    for (const row of sortedRows) {
      worksheet.addRow([
        groupTitle(row, params.groupBy),
        displayUser(row),
        row.shift_date || '',
        displayShift(row),
        displayTimeRange(row),
        displayDuration(row.duration_hours),
        row.division_desc || '',
        row.department_desc || '',
        row.staff_type_name || '',
        row.status || '',
        row.source_type || '',
        Number(row.is_absence) === 1 ? row.absence_type || 'Yes' : 'No',
        row.shift_assignment_id,
        row.shift_period_id || '',
      ]);
    }

    worksheet.views = [{ state: 'frozen', ySplit: 9 }];
    worksheet.autoFilter = {
      from: { row: 9, column: 1 },
      to: { row: 9, column: 14 },
    };

    worksheet.columns = [
      { width: 24 },
      { width: 28 },
      { width: 14 },
      { width: 28 },
      { width: 16 },
      { width: 12 },
      { width: 24 },
      { width: 26 },
      { width: 20 },
      { width: 16 },
      { width: 16 },
      { width: 18 },
      { width: 16 },
      { width: 16 },
    ];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber < 9) return;

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

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `shift_matrix_${buildFileStamp()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(Buffer.from(buffer));
  } catch (err) {
    return sendDbError(res, err, 'desktopShiftMatrixSearchExcel');
  }
});

router.get('/', async (req, res) => {
  const params = getSearchParams(req);

  if (!validateRequiredSearchParams(res, params)) return;
 

  try {
   const { rows } = await pool.query(buildSearchSql(), buildSearchValues(params));
    return res.json(rows);
  } catch (err) {
    return sendDbError(res, err, 'desktopShiftMatrixSearch');
  }
});

module.exports = router;