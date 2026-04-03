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
          updated_at,
          updated_by
        )
        VALUES
        (
          1,
          true,
          true,
          true,
          now(),
          NULL
        )
        RETURNING
          id,
          coverage_validation_enabled,
          gap_validation_enabled,
          overlap_validation_enabled,
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
        updated_at,
        updated_by
      )
      VALUES
      (
        1,
        $1,
        $2,
        $3,
        now(),
        $4
      )
      ON CONFLICT (id)
      DO UPDATE SET
        coverage_validation_enabled = EXCLUDED.coverage_validation_enabled,
        gap_validation_enabled = EXCLUDED.gap_validation_enabled,
        overlap_validation_enabled = EXCLUDED.overlap_validation_enabled,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      RETURNING
        id,
        coverage_validation_enabled,
        gap_validation_enabled,
        overlap_validation_enabled,
        updated_at,
        updated_by
      `,
      [
        coverageValidationEnabled,
        gapValidationEnabled,
        overlapValidationEnabled,
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