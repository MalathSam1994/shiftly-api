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

module.exports = router;
