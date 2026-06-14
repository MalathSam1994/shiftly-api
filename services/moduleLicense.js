'use strict';

function parseLimit(raw, envName) {
  if (raw == null || String(raw).trim() === '') {
    return null; // null = unlimited / disabled
  }

  const n = Number(raw);

  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `${envName} must be a non-negative integer, for example 500.`,
    );
  }

  return n;
}

const MODULES = Object.freeze({
  users: Object.freeze({
    envName: 'SHIFTLY_LICENSE_MAX_USERS',
    maxAllowed: parseLimit(
      process.env.SHIFTLY_LICENSE_MAX_USERS,
      'SHIFTLY_LICENSE_MAX_USERS',
    ),
    table: 'shiftly_schema.users',
    label: 'User',
    lockKey: 910001,
  }),

  divisions: Object.freeze({
    envName: 'SHIFTLY_LICENSE_MAX_DIVISIONS',
    maxAllowed: parseLimit(
      process.env.SHIFTLY_LICENSE_MAX_DIVISIONS,
      'SHIFTLY_LICENSE_MAX_DIVISIONS',
    ),
    table: 'shiftly_schema.divisions',
    label: 'Division',
    lockKey: 910002,
  }),
});

class LicenseLimitError extends Error {
  constructor({ moduleKey, label, maxAllowed, currentCount }) {
    super(
      `${label} license limit reached. Please contact the administrator.`,
    );

    this.name = 'LicenseLimitError';
    this.code = 'LICENSE_LIMIT_EXCEEDED';
    this.http = 400;
    this.moduleKey = moduleKey;

    // Keep these for backend logs/debugging only.
    // Do not expose them to the client response if you want the license config private.
    this.maxAllowed = maxAllowed;
    this.currentCount = currentCount;
  }
}

async function enforceModuleLimit(client, moduleKey) {
  const cfg = MODULES[moduleKey];

  if (!cfg) {
    throw new Error(`Unknown licensed module: ${moduleKey}`);
  }

  // Limit not configured => no restriction.
  if (cfg.maxAllowed == null) {
    return;
  }

  // Transaction-scoped advisory lock.
  // This prevents two parallel inserts from both passing the count check.
  await client.query('SELECT pg_advisory_xact_lock($1)', [cfg.lockKey]);

  // Static table names only from MODULES above, never from req/client input.
  const result = await client.query(
    `SELECT COUNT(*)::int AS current_count FROM ${cfg.table}`,
  );

  const currentCount = Number(result.rows?.[0]?.current_count ?? 0);

  if (currentCount >= cfg.maxAllowed) {
    throw new LicenseLimitError({
      moduleKey,
      label: cfg.label,
      maxAllowed: cfg.maxAllowed,
      currentCount,
    });
  }
}

function isLicenseLimitError(err) {
  return err && err.code === 'LICENSE_LIMIT_EXCEEDED';
}

function buildLicenseLimitResponse(err) {
  return {
    http: err.http || 400,
    body: {
      error: 'Business rule violation',
      details:
        err.message ||
        'License limit reached. Please contact the administrator.',
      code: err.code || 'LICENSE_LIMIT_EXCEEDED',
      module: err.moduleKey,
    },
  };
}

module.exports = {
  enforceModuleLimit,
  isLicenseLimitError,
  buildLicenseLimitResponse,
};
