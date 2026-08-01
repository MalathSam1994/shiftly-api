const pool = require('../db');
const {
  runInTransactionWithBusinessTimezone,
} = require('../utils/shiftlyRuntimeConfig');
const {
  getMaintenanceConfig,
} = require('../utils/shiftRequestMaintenanceConfig');

let timer = null;
let running = false;

async function expirePendingShiftRequestsOnce() {
  const { batchSize } = getMaintenanceConfig();

  const result = await runInTransactionWithBusinessTimezone(pool, (client) =>
    client.query(
      `
      SELECT *
      FROM shiftly_api.expire_pending_shift_requests($1::int, NULL::int)
      `,
      [batchSize],
    ),
  );

  return result.rows?.[0] || { expired_count: 0, expired_request_ids: [] };
}

async function runMaintenanceTick() {
  if (running) return;
  running = true;
  try {
    const result = await expirePendingShiftRequestsOnce();
    const count = Number(result.expired_count || 0);
    if (count > 0) {
      console.log(
        `Shift request expiration rejected ${count} pending request(s).`,
      );
    }
  } catch (error) {
    console.error('Shift request expiration maintenance failed:', error);
  } finally {
    running = false;
  }
}

async function startShiftRequestMaintenance() {
  const config = getMaintenanceConfig();
  if (!config.enabled || timer) return;

  await runMaintenanceTick();
  timer = setInterval(runMaintenanceTick, config.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopShiftRequestMaintenanceForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

module.exports = {
  expirePendingShiftRequestsOnce,
  getMaintenanceConfig,
  startShiftRequestMaintenance,
  stopShiftRequestMaintenanceForTests,
};
