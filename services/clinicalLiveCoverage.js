const pool = require('../db');
const { runInTransactionWithBusinessTimezone } = require('../utils/shiftlyRuntimeConfig');

// One DB detector/lifecycle for background maintenance and both desktop surfaces.
async function evaluateLiveCoverage() {
  return runInTransactionWithBusinessTimezone(pool, async client => {
    const result = await client.query('SELECT shiftly_api.fn_clinical_evaluate_live_coverage() AS result');
    return result.rows[0].result;
  });
}

async function loadLiveCoverage(userId, unitId) {
  return runInTransactionWithBusinessTimezone(pool, async client => {
    const result = await client.query(
      'SELECT shiftly_api.fn_clinical_live_coverage_workspace($1::integer,$2::integer) AS result',
      [userId, unitId],
    );
    return result.rows[0].result;
  });
}

async function acknowledgeLiveCoverage(userId, incidentId) {
  return runInTransactionWithBusinessTimezone(pool, async client => {
    const result = await client.query(
      'SELECT shiftly_api.fn_clinical_acknowledge_live_coverage($1::integer,$2::bigint) AS result',
      [userId, incidentId],
    );
    return result.rows[0].result;
  });
}

module.exports = { evaluateLiveCoverage, loadLiveCoverage, acknowledgeLiveCoverage };
