const pool = require('../db');
const {
  runInTransactionWithBusinessTimezone,
} = require('../utils/shiftlyRuntimeConfig');

let timer = null;
let running = false;

function getClinicalAssignmentMaintenanceConfig() {
  const enabled = String(
    process.env.CLINICAL_ASSIGNMENT_MAINTENANCE_ENABLED || 'true',
  ).toLowerCase() !== 'false';
  const intervalMs = Number.parseInt(
    process.env.CLINICAL_ASSIGNMENT_MAINTENANCE_INTERVAL_MS || '60000',
    10,
  );
  const batchSize = Number.parseInt(
    process.env.CLINICAL_ASSIGNMENT_MAINTENANCE_BATCH_SIZE || '50',
    10,
  );

  return {
    enabled,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 15000 ? intervalMs : 60000,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 50,
  };
}

async function evaluateClinicalAssignmentsOnce() {
  const { batchSize } = getClinicalAssignmentMaintenanceConfig();
  const result = await runInTransactionWithBusinessTimezone(pool, async (client) => {
    await client.query("SELECT set_config('shiftly.clinical_source', 'System', true)");
    return client.query(
      `
      SELECT shiftly_api.fn_clinical_evaluate_due_assignment_reviews($1::int) AS result
      `,
      [batchSize],
    );
  });
  return result.rows?.[0]?.result || { enabled: false, checked: 0 };
}

async function runMaintenanceTick() {
  if (running) return;
  running = true;
  try {
    const result = await evaluateClinicalAssignmentsOnce();
    const count = Number(result.created_or_updated || 0);
    if (count > 0) {
      console.log(
        `Clinical assignment maintenance created/updated ${count} review workflow(s).`,
      );
    }
  } catch (error) {
    console.error('Clinical assignment maintenance failed:', error);
  } finally {
    running = false;
  }
}

async function startClinicalAssignmentMaintenance() {
  const config = getClinicalAssignmentMaintenanceConfig();
  if (!config.enabled || timer) return;

  await runMaintenanceTick();
  timer = setInterval(runMaintenanceTick, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopClinicalAssignmentMaintenanceForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

module.exports = {
  evaluateClinicalAssignmentsOnce,
  getClinicalAssignmentMaintenanceConfig,
  startClinicalAssignmentMaintenance,
  stopClinicalAssignmentMaintenanceForTests,
};
