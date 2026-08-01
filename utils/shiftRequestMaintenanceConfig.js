const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isMaintenanceEnabled() {
  return String(process.env.SHIFT_REQUEST_EXPIRATION_ENABLED || 'true')
    .trim()
    .toLowerCase() !== 'false';
}

function getMaintenanceConfig() {
  return {
    enabled: isMaintenanceEnabled(),
    intervalMs: parsePositiveInt(
      process.env.SHIFT_REQUEST_EXPIRATION_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    batchSize: parsePositiveInt(
      process.env.SHIFT_REQUEST_EXPIRATION_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
    ),
  };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTERVAL_MS,
  getMaintenanceConfig,
  isMaintenanceEnabled,
  parsePositiveInt,
};
