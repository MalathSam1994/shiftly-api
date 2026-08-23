const express = require('express');
const router = express.Router();
const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

function normalizeBoolean(value, fieldName) {
  if (typeof value === 'boolean') {
    return value;
  }

  throw {
    status: 400,
    message: `Invalid value for "${fieldName}". Expected boolean.`,
  };
}

function normalizeNonNegativeInteger(value, fieldName, maxValue = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || (maxValue != null && parsed > maxValue)) {
    throw {
      status: 400,
      message: `Invalid value for "${fieldName}". Expected integer >= 0.`,
    };
  }
  return parsed;
}

function normalizePositiveInteger(value, fieldName, maxValue = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || (maxValue != null && parsed > maxValue)) {
    throw {
      status: 400,
      message: `Invalid value for "${fieldName}". Expected integer >= 1.`,
    };
  }
  return parsed;
}

function normalizeNonNegativeNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw {
      status: 400,
      message: `Invalid value for "${fieldName}". Expected number >= 0.`,
    };
  }
  return parsed;
}

function normalizeNotificationBehavior(value) {
  const normalized = String(value || 'CHANGED_ONLY').trim().toUpperCase();
  if (!['CHANGED_ONLY', 'ALL_ASSIGNED', 'NONE'].includes(normalized)) {
    throw {
      status: 400,
      message: 'Invalid value for "clinical_assignment_change_notification_behavior".',
    };
  }
  return normalized;
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
        clinical_assignment_sync_enabled,
        clinical_handover_check_enabled,
        clinical_handover_check_minutes_before,
        clinical_handover_grace_minutes_after,
        clinical_active_shift_reevaluation_enabled,
        clinical_reevaluation_interval_minutes,
        clinical_imbalance_threshold,
        clinical_new_patient_review_enabled,
        clinical_acuity_change_review_enabled,
        clinical_staffing_change_review_enabled,
        clinical_notify_manager_enabled,
        clinical_require_manager_review_before_optimization,
        clinical_notify_affected_nurses_after_publish,
        clinical_minimum_optimizer_improvement,
        clinical_maximum_active_shift_reassignments,
        clinical_stale_optimization_expiration_minutes,
        clinical_assignment_change_notification_behavior,
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
          clinical_assignment_sync_enabled,
          clinical_handover_check_enabled,
          clinical_handover_check_minutes_before,
          clinical_handover_grace_minutes_after,
          clinical_active_shift_reevaluation_enabled,
          clinical_reevaluation_interval_minutes,
          clinical_imbalance_threshold,
          clinical_new_patient_review_enabled,
          clinical_acuity_change_review_enabled,
          clinical_staffing_change_review_enabled,
          clinical_notify_manager_enabled,
          clinical_require_manager_review_before_optimization,
          clinical_notify_affected_nurses_after_publish,
          clinical_minimum_optimizer_improvement,
          clinical_maximum_active_shift_reassignments,
          clinical_stale_optimization_expiration_minutes,
          clinical_assignment_change_notification_behavior,
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
          true,
          true,
          60,
          15,
          true,
          30,
          1,
          true,
          true,
          true,
          true,
          true,
          true,
          1,
          3,
          60,
          'CHANGED_ONLY',
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
          clinical_assignment_sync_enabled,
          clinical_handover_check_enabled,
          clinical_handover_check_minutes_before,
          clinical_handover_grace_minutes_after,
          clinical_active_shift_reevaluation_enabled,
          clinical_reevaluation_interval_minutes,
          clinical_imbalance_threshold,
          clinical_new_patient_review_enabled,
          clinical_acuity_change_review_enabled,
          clinical_staffing_change_review_enabled,
          clinical_notify_manager_enabled,
          clinical_require_manager_review_before_optimization,
          clinical_notify_affected_nurses_after_publish,
          clinical_minimum_optimizer_improvement,
          clinical_maximum_active_shift_reassignments,
          clinical_stale_optimization_expiration_minutes,
          clinical_assignment_change_notification_behavior,
          updated_at,
          updated_by
        `
      );

      return res.status(200).json(insertResult.rows[0]);
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error loading system configuration:', err);
    return sendPostgresError(req, res, err, {
      action: 'GET',
      label: 'Error loading system configuration',
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

    const mobileDashboardDefaultDays = normalizeNonNegativeInteger(
      req.body.mobile_dashboard_default_days,
      'mobile_dashboard_default_days'
    );
    const desktopDashboardDefaultDays = normalizeNonNegativeInteger(
      req.body.desktop_dashboard_default_days,
      'desktop_dashboard_default_days'
    );
    const breakDurationMinutes = normalizeNonNegativeInteger(
      req.body.break_duration_minutes,
      'break_duration_minutes'
    );
    const shiftHandoverMinutes = normalizeNonNegativeInteger(
      req.body.shift_handover_minutes,
      'shift_handover_minutes'
    );
    const clinicalAssignmentSyncEnabled = normalizeBoolean(
      req.body.clinical_assignment_sync_enabled,
      'clinical_assignment_sync_enabled'
    );
    const clinicalHandoverCheckEnabled = normalizeBoolean(
      req.body.clinical_handover_check_enabled,
      'clinical_handover_check_enabled'
    );
    const clinicalHandoverCheckMinutesBefore = normalizeNonNegativeInteger(
      req.body.clinical_handover_check_minutes_before,
      'clinical_handover_check_minutes_before',
      1440
    );
    const clinicalHandoverGraceMinutesAfter = normalizeNonNegativeInteger(
      req.body.clinical_handover_grace_minutes_after,
      'clinical_handover_grace_minutes_after',
      240
    );
    const clinicalActiveShiftReevaluationEnabled = normalizeBoolean(
      req.body.clinical_active_shift_reevaluation_enabled,
      'clinical_active_shift_reevaluation_enabled'
    );
    const clinicalReevaluationIntervalMinutes = normalizePositiveInteger(
      req.body.clinical_reevaluation_interval_minutes,
      'clinical_reevaluation_interval_minutes',
      1440
    );
    const clinicalImbalanceThreshold = normalizeNonNegativeNumber(
      req.body.clinical_imbalance_threshold,
      'clinical_imbalance_threshold'
    );
    const clinicalNewPatientReviewEnabled = normalizeBoolean(
      req.body.clinical_new_patient_review_enabled,
      'clinical_new_patient_review_enabled'
    );
    const clinicalAcuityChangeReviewEnabled = normalizeBoolean(
      req.body.clinical_acuity_change_review_enabled,
      'clinical_acuity_change_review_enabled'
    );
    const clinicalStaffingChangeReviewEnabled = normalizeBoolean(
      req.body.clinical_staffing_change_review_enabled,
      'clinical_staffing_change_review_enabled'
    );
    const clinicalNotifyManagerEnabled = normalizeBoolean(
      req.body.clinical_notify_manager_enabled,
      'clinical_notify_manager_enabled'
    );
    const clinicalRequireManagerReviewBeforeOptimization = normalizeBoolean(
      req.body.clinical_require_manager_review_before_optimization,
      'clinical_require_manager_review_before_optimization'
    );
    const clinicalNotifyAffectedNursesAfterPublish = normalizeBoolean(
      req.body.clinical_notify_affected_nurses_after_publish,
      'clinical_notify_affected_nurses_after_publish'
    );
    const clinicalMinimumOptimizerImprovement = normalizeNonNegativeNumber(
      req.body.clinical_minimum_optimizer_improvement,
      'clinical_minimum_optimizer_improvement'
    );
    const clinicalMaximumActiveShiftReassignments = normalizeNonNegativeInteger(
      req.body.clinical_maximum_active_shift_reassignments,
      'clinical_maximum_active_shift_reassignments',
      100
    );
    const clinicalStaleOptimizationExpirationMinutes = normalizePositiveInteger(
      req.body.clinical_stale_optimization_expiration_minutes,
      'clinical_stale_optimization_expiration_minutes',
      10080
    );
    const clinicalAssignmentChangeNotificationBehavior =
      normalizeNotificationBehavior(
        req.body.clinical_assignment_change_notification_behavior
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
        mobile_dashboard_default_days,
        desktop_dashboard_default_days,
        break_duration_minutes,
        shift_handover_minutes,
        clinical_assignment_sync_enabled,
        clinical_handover_check_enabled,
        clinical_handover_check_minutes_before,
        clinical_handover_grace_minutes_after,
        clinical_active_shift_reevaluation_enabled,
        clinical_reevaluation_interval_minutes,
        clinical_imbalance_threshold,
        clinical_new_patient_review_enabled,
        clinical_acuity_change_review_enabled,
        clinical_staffing_change_review_enabled,
        clinical_notify_manager_enabled,
        clinical_require_manager_review_before_optimization,
        clinical_notify_affected_nurses_after_publish,
        clinical_minimum_optimizer_improvement,
        clinical_maximum_active_shift_reassignments,
        clinical_stale_optimization_expiration_minutes,
        clinical_assignment_change_notification_behavior,
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
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        $23,
        $24,
        now(),
        $25
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
        clinical_assignment_sync_enabled = EXCLUDED.clinical_assignment_sync_enabled,
        clinical_handover_check_enabled = EXCLUDED.clinical_handover_check_enabled,
        clinical_handover_check_minutes_before = EXCLUDED.clinical_handover_check_minutes_before,
        clinical_handover_grace_minutes_after = EXCLUDED.clinical_handover_grace_minutes_after,
        clinical_active_shift_reevaluation_enabled = EXCLUDED.clinical_active_shift_reevaluation_enabled,
        clinical_reevaluation_interval_minutes = EXCLUDED.clinical_reevaluation_interval_minutes,
        clinical_imbalance_threshold = EXCLUDED.clinical_imbalance_threshold,
        clinical_new_patient_review_enabled = EXCLUDED.clinical_new_patient_review_enabled,
        clinical_acuity_change_review_enabled = EXCLUDED.clinical_acuity_change_review_enabled,
        clinical_staffing_change_review_enabled = EXCLUDED.clinical_staffing_change_review_enabled,
        clinical_notify_manager_enabled = EXCLUDED.clinical_notify_manager_enabled,
        clinical_require_manager_review_before_optimization = EXCLUDED.clinical_require_manager_review_before_optimization,
        clinical_notify_affected_nurses_after_publish = EXCLUDED.clinical_notify_affected_nurses_after_publish,
        clinical_minimum_optimizer_improvement = EXCLUDED.clinical_minimum_optimizer_improvement,
        clinical_maximum_active_shift_reassignments = EXCLUDED.clinical_maximum_active_shift_reassignments,
        clinical_stale_optimization_expiration_minutes = EXCLUDED.clinical_stale_optimization_expiration_minutes,
        clinical_assignment_change_notification_behavior = EXCLUDED.clinical_assignment_change_notification_behavior,
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
        clinical_assignment_sync_enabled,
        clinical_handover_check_enabled,
        clinical_handover_check_minutes_before,
        clinical_handover_grace_minutes_after,
        clinical_active_shift_reevaluation_enabled,
        clinical_reevaluation_interval_minutes,
        clinical_imbalance_threshold,
        clinical_new_patient_review_enabled,
        clinical_acuity_change_review_enabled,
        clinical_staffing_change_review_enabled,
        clinical_notify_manager_enabled,
        clinical_require_manager_review_before_optimization,
        clinical_notify_affected_nurses_after_publish,
        clinical_minimum_optimizer_improvement,
        clinical_maximum_active_shift_reassignments,
        clinical_stale_optimization_expiration_minutes,
        clinical_assignment_change_notification_behavior,
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
        clinicalAssignmentSyncEnabled,
        clinicalHandoverCheckEnabled,
        clinicalHandoverCheckMinutesBefore,
        clinicalHandoverGraceMinutesAfter,
        clinicalActiveShiftReevaluationEnabled,
        clinicalReevaluationIntervalMinutes,
        clinicalImbalanceThreshold,
        clinicalNewPatientReviewEnabled,
        clinicalAcuityChangeReviewEnabled,
        clinicalStaffingChangeReviewEnabled,
        clinicalNotifyManagerEnabled,
        clinicalRequireManagerReviewBeforeOptimization,
        clinicalNotifyAffectedNursesAfterPublish,
        clinicalMinimumOptimizerImprovement,
        clinicalMaximumActiveShiftReassignments,
        clinicalStaleOptimizationExpirationMinutes,
        clinicalAssignmentChangeNotificationBehavior,
        updatedBy,
      ]
    );

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error updating system configuration:', err);

    if (err && err.status) {
      return sendApiError(req, res, {
        status: err.status,
        error: 'The request contains invalid fields.',
        code: 'INVALID_REQUEST',
        details: typeof err.message === 'string' &&
          err.message.startsWith('Invalid value')
          ? err.message
          : 'Invalid configuration value.',
      });
    }

    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error updating system configuration',
    });
  }
});

module.exports = router;
