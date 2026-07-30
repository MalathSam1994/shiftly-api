
const express = require('express');
const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const userId = Number(req.query.user_id ?? req.query.userId);
    const rawDate = (req.query.date ?? '').toString().trim();

    if (!Number.isFinite(userId)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A valid user is required.',
        code: 'INVALID_REQUEST',
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return sendApiError(req, res, {
        status: 400,
        error: 'A valid date is required.',
        code: 'INVALID_REQUEST',
      });
    }

    const result = await pool.query(
      `SELECT shiftly_api.fn_mobile_day_details_ui($1::int, $2::date) AS payload`,
      [userId, rawDate],
    );

    if (!result.rows?.length) {
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
      label: 'Error loading mobile day details UI',
    });
  }
});

module.exports = router;
