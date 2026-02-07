// query/mobileDashboard.js
// Read-only dashboard endpoint backed by: shiftly_api.fn_mobile_dashboard
//
// GET /dashboard/mobile?userId=2
// Optional:
//   &from=2026-01-01&to=2026-02-01
//
const express = require('express');
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
  Object.keys(payload).forEach((k) => payload[k] == null && delete payload[k]);
  return res.status(500).json(payload);
}

function asIntOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function asDateStringOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Expect YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

router.get('/', async (req, res) => {
  const userId = asIntOrNull(req.query.userId);
  const from = asDateStringOrNull(req.query.from);
  const to = asDateStringOrNull(req.query.to);

  if (!userId) {
    return res.status(400).json({
      error: 'Missing required query params',
      required: ['userId'],
      example: '/dashboard/mobile?userId=2',
    });
  }

  let sql = '';
  let values = [];

  if (from && to) {
    sql = `SELECT * FROM shiftly_api.fn_mobile_dashboard($1::int, $2::date, $3::date);`;
    values = [userId, from, to];
  } else if (from && !to) {
    // If caller provides only "from", assume "to" = from + 1 month
    sql = `
      SELECT * FROM shiftly_api.fn_mobile_dashboard(
        $1::int,
        $2::date,
        (date_trunc('month', $2::date) + interval '1 month')::date
      );
    `;
    values = [userId, from];
  } else if (!from && to) {
    // If caller provides only "to", infer "from" from the month of (to - 1 day)
    sql = `
      SELECT * FROM shiftly_api.fn_mobile_dashboard(
        $1::int,
        date_trunc('month', ($2::date - interval '1 day'))::date,
        $2::date
      );
    `;
    values = [userId, to];
  } else {
    // No dates => function defaults to current month
    sql = `SELECT * FROM shiftly_api.fn_mobile_dashboard($1::int);`;
    values = [userId];
  }

  try {
    const { rows } = await pool.query(sql, values);
    if (!rows || rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: `User ${userId} not found or no dashboard row returned.`,
      });
    }
    return res.json(rows[0]);
  } catch (err) {
    return sendDbError(res, err, 'mobileDashboard');
  }
});

module.exports = router;