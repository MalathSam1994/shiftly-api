const pool = require('../db');
const { reconcileAttention } = require('./attention');
const { evaluateLiveCoverage } = require('./clinicalLiveCoverage');
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
  // Commit the unit sweep independently. A failing/batched shift review must
  // never starve units with no shifts, or roll back their coverage notifications.
  let liveCoverage;
  try {
    liveCoverage = await evaluateLiveCoverage();
    if (liveCoverage.errors?.length) {
      console.error('Live coverage: some units could not be checked:', liveCoverage.errors);
    }
  } catch (error) {
    console.error('Live coverage maintenance failed:', error);
    liveCoverage = { checked: 0, failed: true };
  }
  let reviewResult = { checked: 0, failed: true };
  try {
    const result = await runInTransactionWithBusinessTimezone(pool, async client => {
      await client.query("SELECT set_config('shiftly.clinical_source', 'System', true)");
      return client.query('SELECT shiftly_api.fn_clinical_evaluate_due_assignment_reviews($1::int) AS result', [batchSize]);
    });
    reviewResult = result.rows?.[0]?.result || reviewResult;
  } catch (error) {
    console.error('Clinical review maintenance failed:', error);
  }
  // Commit independently, including catch-up when an unchanged workflow took
  // its early return. First reconciliation is in-app only in PostgreSQL.
  let attention;
  try { attention = await reconcileAttention(); }
  catch (error) {
    console.error('Attention reconciliation failed; retained findings are stale:', error);
    attention = { failed: true };
  }
  return { ...reviewResult, live_coverage: liveCoverage, attention };
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
