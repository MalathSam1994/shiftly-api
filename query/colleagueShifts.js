// query/colleagueShifts.js
// GET /colleague-shifts?base_user_id=2&shift_date=2026-01-01
// Uses DB view: shiftly_schema.v_colleague_shifts_in_user_metrics

const express = require('express');
const router = express.Router();

// NOTE: adjust this import if your pool is exported from a different path
const pool = require('../db');

router.get('/', async (req, res) => {
  try {
    const qp = req.query || {};

    const rawBaseUserId = qp.base_user_id ?? qp.baseUserId;
    const baseUserId =
      rawBaseUserId != null && rawBaseUserId !== ''
        ? Number(rawBaseUserId)
        : null;

    const shiftDate = (qp.shift_date ?? qp.shiftDate ?? '').toString().trim();

    if (!baseUserId || !Number.isFinite(baseUserId)) {
      return res
        .status(400)
        .json({ error: 'base_user_id is required and must be a number' });
    }

    const where = [];
    const params = [];
    let i = 1;

    params.push(baseUserId);
    where.push(`base_user_id = $${i++}`);

    // Optional (if omitted => all dates for that base user)
    if (shiftDate) {
      params.push(shiftDate);
      where.push(`shift_date::date = $${i++}::date`);
    }

    const sql = `
      SELECT *
      FROM shiftly_schema.v_colleague_shifts_in_user_metrics
      WHERE ${where.join(' AND ')}
      ORDER BY shift_date ASC, division_id ASC, department_id ASC, shift_type_id ASC, colleague_user_id ASC
    `;

    const result = await pool.query(sql, params);
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /colleague-shifts failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;