const express = require('express');
const router = express.Router();
const pool = require('../db');

function normalizeBoolean(value, fieldName) {
  if (typeof value === 'boolean') {
    return value;
  }

  throw {
    status: 400,
    message: `Invalid value for "${fieldName}". Expected boolean.`,
  };
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        coverage_validation_enabled,
        gap_validation_enabled,
        overlap_validation_enabled,
        mobile_dashboard_default_days,
        desktop_dashboard_default_days,
        break_duration_minutes,
        shift_handover_minutes,
        updated_at,
        updated_by
      FROM shiftly_schema.system_configuration
      WHERE id = 1
      `
    );

    if (!result.rows || result.rows.length === 0) {
      const insertResult = await pool.query(
        `
        INSERT INTO shiftly_schema.system_configuration
        (
          id,
          coverage_validation_enabled,
          gap_validation_enabled,
          overlap_validation_enabled,
          mobile_dashboard_default_days,
          desktop_dashboard_default_days,
          break_duration_minutes,
          shift_handover_minutes,
          updated_at,
          updated_by
        )
        VALUES
        (
          1,
          true,
          true,
          true,
          14,
          14,
          0,
          0,
          now(),
          NULL
        )
        RETURNING
          id,
          coverage_validation_enabled,
          gap_validation_enabled,
          overlap_validation_enabled,
           mobile_dashboard_default_days,
          desktop_dashboard_default_days,
          break_duration_minutes,
          shift_handover_minutes,
          updated_at,
          updated_by
        `
      );

      return res.status(200).json(insertResult.rows[0]);
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error loading system configuration:', err);
    return res.status(500).json({
      error: 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

router.put('/', async (req, res) => {
  try {
    const coverageValidationEnabled = normalizeBoolean(
      req.body.coverage_validation_enabled,
      'coverage_validation_enabled'
    );

    const gapValidationEnabled = normalizeBoolean(
      req.body.gap_validation_enabled,
      'gap_validation_enabled'
    );

    const overlapValidationEnabled = normalizeBoolean(
      req.body.overlap_validation_enabled,
      'overlap_validation_enabled'
    );

    const mobileDashboardDefaultDays = Number.parseInt(
      String(req.body.mobile_dashboard_default_days ?? ''),
      10
    );
    if (!Number.isFinite(mobileDashboardDefaultDays) || mobileDashboardDefaultDays < 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: 'Invalid value for "mobile_dashboard_default_days". Expected integer >= 0.',
      });
    }

    const desktopDashboardDefaultDays = Number.parseInt(
      String(req.body.desktop_dashboard_default_days ?? ''),
      10
    );
    if (!Number.isFinite(desktopDashboardDefaultDays) || desktopDashboardDefaultDays < 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: 'Invalid value for "desktop_dashboard_default_days". Expected integer >= 0.',
      });
    }


    const breakDurationMinutes = Number.parseInt(
      String(req.body.break_duration_minutes ?? ''),
      10
    );
    if (!Number.isFinite(breakDurationMinutes) || breakDurationMinutes < 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: 'Invalid value for "break_duration_minutes". Expected integer >= 0.',
      });
    }

    const shiftHandoverMinutes = Number.parseInt(
      String(req.body.shift_handover_minutes ?? ''),
      10
    );
    if (!Number.isFinite(shiftHandoverMinutes) || shiftHandoverMinutes < 0) {
      return res.status(400).json({
        error: 'Validation error',
        details: 'Invalid value for "shift_handover_minutes". Expected integer >= 0.',
      });
    }

    const updatedBy =
      req.user && req.user.id != null
        ? Number(req.user.id)
        : null;

    const result = await pool.query(
      `
      INSERT INTO shiftly_schema.system_configuration
      (
        id,
        coverage_validation_enabled,
        gap_validation_enabled,
        overlap_validation_enabled,
           mobile_dashboard_default_days,
        desktop_dashboard_default_days,
        break_duration_minutes,
        shift_handover_minutes,
        updated_at,
        updated_by
      )
      VALUES
      (
        1,
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        now(),
        $8
      )
      ON CONFLICT (id)
      DO UPDATE SET
        coverage_validation_enabled = EXCLUDED.coverage_validation_enabled,
        gap_validation_enabled = EXCLUDED.gap_validation_enabled,
        overlap_validation_enabled = EXCLUDED.overlap_validation_enabled,
        mobile_dashboard_default_days = EXCLUDED.mobile_dashboard_default_days,
        desktop_dashboard_default_days = EXCLUDED.desktop_dashboard_default_days,
        break_duration_minutes = EXCLUDED.break_duration_minutes,
        shift_handover_minutes = EXCLUDED.shift_handover_minutes,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      RETURNING
        id,
        coverage_validation_enabled,
        gap_validation_enabled,
        overlap_validation_enabled,
       mobile_dashboard_default_days,
        desktop_dashboard_default_days,
        break_duration_minutes,
        shift_handover_minutes,
        updated_at,
        updated_by
      `,
      [
        coverageValidationEnabled,
        gapValidationEnabled,
        overlapValidationEnabled,
        mobileDashboardDefaultDays,
        desktopDashboardDefaultDays,
        breakDurationMinutes,
        shiftHandoverMinutes,
        updatedBy,
      ]
    );

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error updating system configuration:', err);

    if (err && err.status) {
      return res.status(err.status).json({
        error: 'Validation error',
        details: err.message,
      });
    }

    return res.status(500).json({
      error: 'Database error',
      details: err.message,
      code: err.code,
      routine: err.routine,
    });
  }
});

module.exports = router;