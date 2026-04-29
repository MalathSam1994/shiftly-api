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

function parseYyyyMmDd(value) {
  if (!value) return null;
  const parts = String(value).substring(0, 10).split('-');
  if (parts.length !== 3) return null;

  const year = Number.parseInt(parts[0], 10);
  const month = Number.parseInt(parts[1], 10);
  const day = Number.parseInt(parts[2], 10);

  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date, days) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days,
  ));
}

function dateKey(date) {
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function dateLabel(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function weekdayLabel(date) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] || '';
}

function daysBetween(from, to) {
  const start = parseYyyyMmDd(from);
  const end = parseYyyyMmDd(to);
  if (!start || !end) return [];

  const days = [];
  for (
    let current = start;
    current < end;
    current = addUtcDays(current, 1)
  ) {
    days.push(current);
  }
  return days;
}

function minuteOfDay(value) {
  const text = hhMm(value);
  if (!/^\d{2}:\d{2}$/.test(text)) return 0;

  const hour = Number.parseInt(text.substring(0, 2), 10);
  const minute = Number.parseInt(text.substring(3, 5), 10);
  const total = (hour * 60) + minute;

  return Math.max(0, Math.min(24 * 60, total));
}

function statusArgb(status, opacityHex = '2A') {
  const normalized = String(status || '').trim().toUpperCase();

 if (normalized === 'APPROVED') return 'FFE4EBD8';
  if (normalized === 'PENDING' || normalized.startsWith('PENDING_')) {
    return `${opacityHex}FF9800`;
  }
   if (normalized === 'CANCELLED') return 'FFE9D4D3';

  return `${opacityHex}607D8B`;
}

function statusBorderArgb(status) {
  const normalized = String(status || '').trim().toUpperCase();

if (normalized === 'APPROVED') return 'FF8EA36E';
  if (normalized === 'PENDING' || normalized.startsWith('PENDING_')) {
    return 'FFFF9800';
  }
  if (normalized === 'CANCELLED') return 'FFB98583';

  return 'FF607D8B';
}

function buildMatrixLines(rows, groupBy) {
  const grouped = new Map();

  for (const row of rows) {
    const key = groupTitle(row, groupBy);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const groupKeys = [...grouped.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );

  const lines = [];

  for (const groupKey of groupKeys) {
    lines.push({
      type: 'group',
      groupTitle: groupKey,
      userLabel: '',
      userSubLabel: '',
      shifts: [],
    });

    const byUser = new Map();
    for (const row of grouped.get(groupKey)) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }

    const userIds = [...byUser.keys()].sort((a, b) => {
      const userA = displayUser(byUser.get(a)[0]);
      const userB = displayUser(byUser.get(b)[0]);
      return userA.localeCompare(userB, undefined, { sensitivity: 'base' });
    });

    for (const userId of userIds) {
      const userRows = byUser.get(userId).sort((a, b) => {
        const dateCompare = String(a.shift_date || '').localeCompare(
          String(b.shift_date || ''),
        );
        if (dateCompare !== 0) return dateCompare;
        return hhMm(a.start_time).localeCompare(hhMm(b.start_time));
      });
      const first = userRows[0];

      lines.push({
        type: 'user',
        groupTitle: '',
        userLabel: displayUser(first),
        userSubLabel: first.staff_type_name || '',
        shifts: userRows,
      });
    }
  }

  return lines;
}

function styleThinBorder(color = 'FFE0E0E0') {
  return {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  };
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


router.get('/excel-matrix', async (req, res) => {
  const params = getSearchParams(req);

  if (!validateRequiredSearchParams(res, params)) return;

  try {
    const { rows } = await pool.query(buildSearchSql(), buildSearchValues(params));
    const days = daysBetween(params.from, params.to);
    const lines = buildMatrixLines(rows, params.groupBy);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Shiftly';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet(safeSheetName('Shift Matrix Layout'));

    worksheet.properties.defaultRowHeight = 24;
    worksheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 6 }];

    worksheet.mergeCells(1, 1, 1, Math.max(2 + (days.length * 4), 8));
    worksheet.getCell(1, 1).value = 'Shift Matrix Layout Report';
    worksheet.getCell(1, 1).font = {
      bold: true,
      size: 18,
      color: { argb: 'FFFFFFFF' },
    };
    worksheet.getCell(1, 1).alignment = {
      horizontal: 'center',
      vertical: 'middle',
    };
    worksheet.getCell(1, 1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1565C0' },
    };
    worksheet.getRow(1).height = 30;

    worksheet.getCell(2, 1).value = 'From';
    worksheet.getCell(2, 2).value = params.from;
    worksheet.getCell(3, 1).value = 'To exclusive';
    worksheet.getCell(3, 2).value = params.to;
    worksheet.getCell(4, 1).value = 'Grouped by';
    worksheet.getCell(4, 2).value = groupByLabel(params.groupBy);
    worksheet.getCell(5, 1).value = 'Rows';
    worksheet.getCell(5, 2).value = rows.length;

    for (let rowNumber = 2; rowNumber <= 5; rowNumber += 1) {
      worksheet.getCell(rowNumber, 1).font = { bold: true };
      worksheet.getCell(rowNumber, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE3F2FD' },
      };
      worksheet.getCell(rowNumber, 1).border = styleThinBorder('FFBBDEFB');
      worksheet.getCell(rowNumber, 2).border = styleThinBorder('FFBBDEFB');
    }

    const leftHeaderRow = 6;
    worksheet.getCell(leftHeaderRow, 1).value = groupByLabel(params.groupBy);
    worksheet.getCell(leftHeaderRow, 2).value = 'Users';

    worksheet.getCell(leftHeaderRow + 1, 1).value = '';
    worksheet.getCell(leftHeaderRow + 1, 2).value = '';

    worksheet.mergeCells(leftHeaderRow, 1, leftHeaderRow + 1, 1);
    worksheet.mergeCells(leftHeaderRow, 2, leftHeaderRow + 1, 2);

    for (let col = 1; col <= 2; col += 1) {
      const cell = worksheet.getCell(leftHeaderRow, col);
      cell.font = { bold: true, color: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' },
      };
      cell.border = styleThinBorder('FFD1D5DB');
    }

    days.forEach((day, index) => {
      const firstCol = 3 + (index * 4);
      const lastCol = firstCol + 3;

      worksheet.mergeCells(leftHeaderRow, firstCol, leftHeaderRow, lastCol);
      const dayCell = worksheet.getCell(leftHeaderRow, firstCol);
      dayCell.value = `${dateLabel(day)}\n${weekdayLabel(day)}`;
      dayCell.font = { bold: true, color: { argb: 'FF1F2937' }, size: 11 };
      dayCell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      dayCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' },
      };
      dayCell.border = styleThinBorder('FFD1D5DB');

      ['00', '06', '12', '18'].forEach((mark, markIndex) => {
        const cell = worksheet.getCell(leftHeaderRow + 1, firstCol + markIndex);
        cell.value = mark;
        cell.font = { bold: true, size: 9, color: { argb: 'FF6B7280' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF3F4F6' },
        };
        cell.border = styleThinBorder('FFD1D5DB');
      });
    });

    worksheet.getRow(leftHeaderRow).height = 30;
    worksheet.getRow(leftHeaderRow + 1).height = 20;

    worksheet.getColumn(1).width = 24;
    worksheet.getColumn(2).width = 30;

    for (let col = 3; col <= 2 + (days.length * 4); col += 1) {
      worksheet.getColumn(col).width = 8;
    }

    let excelRowNumber = leftHeaderRow + 2;

    for (const line of lines) {
      if (line.type === 'group') {
        worksheet.mergeCells(excelRowNumber, 1, excelRowNumber, Math.max(2 + (days.length * 4), 3));
        const groupCell = worksheet.getCell(excelRowNumber, 1);
        groupCell.value = line.groupTitle;
        groupCell.font = { bold: true, color: { argb: 'FF1565C0' }, size: 11 };
        groupCell.alignment = { vertical: 'middle' };
        groupCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE3F2FD' },
        };
        groupCell.border = styleThinBorder('FFBBDEFB');
        worksheet.getRow(excelRowNumber).height = 22;
        excelRowNumber += 1;
        continue;
      }

      worksheet.getCell(excelRowNumber, 1).value = '';
      worksheet.getCell(excelRowNumber, 2).value = line.userSubLabel
        ? `${line.userLabel}\n${line.userSubLabel}`
        : line.userLabel;

      for (let col = 1; col <= 2 + (days.length * 4); col += 1) {
        const cell = worksheet.getCell(excelRowNumber, col);
        cell.alignment = {
          vertical: 'middle',
          horizontal: col <= 2 ? 'left' : 'center',
          wrapText: true,
        };
        cell.border = styleThinBorder('FFE5E7EB');
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: col <= 2 ? 'FFFFFFFF' : 'FFFCFCFD' },
        };
      }

      worksheet.getCell(excelRowNumber, 2).font = {
        bold: true,
        size: 10,
        color: { argb: 'FF111827' },
      };

      days.forEach((day, dayIndex) => {
        const key = dateKey(day);
        const dayShifts = line.shifts.filter((row) => row.shift_date === key);

        dayShifts.forEach((shift, shiftIndex) => {
          const startMinute = minuteOfDay(shift.start_time);
          const endMinuteRaw = minuteOfDay(shift.end_time);
          const endMinute = endMinuteRaw <= startMinute ? 24 * 60 : endMinuteRaw;

          const startSlot = Math.max(0, Math.min(3, Math.floor(startMinute / 360)));
          const endSlot = Math.max(
            startSlot,
            Math.min(3, Math.ceil(endMinute / 360) - 1),
          );

          const firstCol = 3 + (dayIndex * 4) + startSlot;
          const lastCol = 3 + (dayIndex * 4) + endSlot;

          if (lastCol > firstCol) {
            try {
              worksheet.mergeCells(excelRowNumber, firstCol, excelRowNumber, lastCol);
            } catch (_) {
              // Ignore overlapping merge attempts when a user has multiple shifts in same slot.
            }
          }

          const cell = worksheet.getCell(excelRowNumber, firstCol);
          const existing = String(cell.value || '').trim();
          const text = [
            displayShift(shift),
            displayTimeRange(shift),
          ].filter(Boolean).join(' - ');

          cell.value = existing ? `${existing}\n${text}` : text;
          cell.font = {
            bold: true,
            size: shiftIndex > 0 ? 8 : 9,
            color: { argb: 'FF1F2937' },
          };
          cell.alignment = {
            horizontal: 'center',
            vertical: 'middle',
            wrapText: true,
          };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: statusArgb(shift.status, '33') },
          };
          cell.border = {
            top: { style: 'thin', color: { argb: statusBorderArgb(shift.status) } },
            left: { style: 'thin', color: { argb: statusBorderArgb(shift.status) } },
            bottom: { style: 'thin', color: { argb: statusBorderArgb(shift.status) } },
            right: { style: 'thin', color: { argb: statusBorderArgb(shift.status) } },
          };
        });
      });

      worksheet.getRow(excelRowNumber).height = 46;
      excelRowNumber += 1;
    }

    if (lines.length === 0) {
      worksheet.mergeCells(excelRowNumber, 1, excelRowNumber, Math.max(2 + (days.length * 4), 3));
      worksheet.getCell(excelRowNumber, 1).value = 'No shifts found for the selected range and filters.';
      worksheet.getCell(excelRowNumber, 1).alignment = { horizontal: 'center' };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `shift_matrix_layout_${buildFileStamp()}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(Buffer.from(buffer));
  } catch (err) {
    return sendDbError(res, err, 'desktopShiftMatrixSearchExcelMatrix');
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