const express = require('express');
const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

const router = express.Router();

function actorUserId(req) {
  const userId = Number(req.user?.sub ?? req.user?.id);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function parseOptionalDate(value) {
  if (value == null || `${value}`.trim() === '') return null;
  const text = `${value}`.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

router.get('/manager/clinical-summary', async (req, res) => {
  const userId = actorUserId(req);
  if (!userId) {
    return sendApiError(req, res, {
      status: 401,
      error: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
  }

  const from = parseOptionalDate(req.query.from);
  const to = parseOptionalDate(req.query.to);
  if (from === undefined || to === undefined) {
    return sendApiError(req, res, {
      status: 400,
      error: 'from and to must be provided as YYYY-MM-DD when present.',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await pool.query(
      `SELECT shiftly_api.fn_manager_clinical_dashboard_summary(
         $1::integer,
         $2::date,
         $3::date
       ) AS summary`,
      [userId, from, to],
    );
    return res.json(result.rows[0]?.summary || {});
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading manager clinical dashboard summary',
    });
  }
});

router.get('/mobile/clinical-summary', async (req, res) => {
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
      `SELECT shiftly_api.fn_mobile_clinical_dashboard_summary(
         $1::integer
       ) AS summary`,
      [userId],
    );
    return res.json(result.rows[0]?.summary || {});
  } catch (err) {
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading mobile clinical dashboard summary',
    });
  }
});


// A single scoped DB snapshot also backs the workbook, keeping metric definitions identical.
const { runInTransactionWithBusinessTimezone } = require('../utils/shiftlyRuntimeConfig');
function workspaceFilters(query) {
  const date = value => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
    const parsed = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
    return value;
  };
  const id = value => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) throw new Error('Invalid identifier');
    return Number(value);
  };
  const from = date(query.from), to = date(query.to);
  if (to && !from) throw new Error('from is required with to');
  if (from && to && (to <= from || (Date.parse(to) - Date.parse(from)) / 86400000 > 31)) throw new Error('Invalid period');
  return [from, to, id(query.unitId), id(query.shiftTypeId), id(query.staffTypeId)];
}
async function workspace(req, res) {
  const userId = actorUserId(req);
  if (!userId) return sendApiError(req, res, { status: 401, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' });
  let filters;
  try { filters = workspaceFilters(req.query); }
  catch (_) { return sendApiError(req, res, { status: 400, error: 'Use valid YYYY-MM-DD dates, a 1–31 day range (exclusive end), and positive integer filter IDs.', code: 'INVALID_REQUEST' }); }
  try {
    const snapshot = await runInTransactionWithBusinessTimezone(pool, async client => {
      const result = await client.query('SELECT shiftly_api.fn_manager_dashboard_workspace($1::integer,$2::date,$3::date,$4::integer,$5::integer,$6::integer) AS snapshot', [userId, ...filters]);
      return result.rows[0].snapshot;
    });
    res.set('Cache-Control', 'no-store');
    if (!req.path.endsWith('/excel')) return res.json(snapshot);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet('Overview');
    summary.addRow(['ShiftMix Clinical & Workforce Overview']);
    summary.addRow(['Generated', snapshot.generated_at]);
    summary.addRow(['From', snapshot.from, 'To (exclusive)', snapshot.to]);
    summary.addRow(['Unit ID', filters[2] ?? 'All', 'Shift type ID', filters[3] ?? 'All', 'Staff type ID', filters[4] ?? 'All']);
    summary.addRow([snapshot.clinical_basis]); summary.addRow([snapshot.staffing_basis]);
    summary.addRow(['Bed occupancy uses configured beds; unknown locations/capacity yield no percentage. Average acuity is only comparable within one rule set.']);
    summary.addRow(['Patient preview', snapshot.patients.length, 'Total census', snapshot.patient_total]);
    for (const [key, value] of Object.entries(snapshot.kpis)) summary.addRow([key, value ?? 'Unavailable']);
    for (const [name, rows] of [['Patients (up to 500)', snapshot.patients], ['Units', snapshot.by_unit], ['Workload', snapshot.workload], ['Schedule', snapshot.schedule], ['Alerts (up to 100)', snapshot.alerts], ['Handover reviews', snapshot.handovers || []]]) {
      const sheet = workbook.addWorksheet(name);
      const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(key => key !== 'scope' && key !== 'ineligibility_reasons');
      sheet.addRow(keys);
      for (const row of rows) sheet.addRow(keys.map(key => row[key] == null ? '' : typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]));
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.getRow(1).font = { bold: true };
      (sheet.columns || []).forEach(column => { column.width = 23; });
    }
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="shiftmix-dashboard.xlsx"');
    return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (err) { return sendPostgresError(req, res, err, { action: 'GET', label: 'Error loading manager workspace' }); }
}
router.get('/manager/workspace', workspace);
router.get('/manager/workspace/excel', workspace);

module.exports = router;
