const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  getBusinessTimezone,
} = require('../utils/shiftlyRuntimeConfig');
const {
  getMaintenanceConfig,
} = require('../utils/shiftRequestMaintenanceConfig');

const migrationPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'DB',
  'shift_request_overlap_and_expiration_protection.sql',
);

test('workflow protection migration defines overlap and expiration source-of-truth objects', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.shift_request_approve/i);
  assert.match(sql, /CREATE TRIGGER trg_prevent_approved_assignment_overlap/i);
  assert.match(sql, /pg_advisory_xact_lock\(917240/i);
  assert.match(sql, /FOR UPDATE OF sr SKIP LOCKED/i);
  assert.match(sql, /shiftly_api\.expire_pending_shift_requests/i);
  assert.match(sql, /shiftly_api\.current_business_timestamp/i);
  assert.match(sql, /shiftly_api\.v_approved_shift_assignment_overlaps/i);
});

test('workflow protection migration uses actual timestamps, not same-date-only checks', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /p_left_start < p_right_end/i);
  assert.match(sql, /p_right_start < p_left_end/i);
  assert.match(sql, /WHEN p_end_time <= p_start_time THEN INTERVAL '1 day'/i);
  assert.doesNotMatch(sql, /sa\.shift_date = p_shift_date\s+AND\s+.*shift_type_id/is);
});

test('business timezone config prefers explicit Shiftly setting', () => {
  const originalShiftly = process.env.SHIFTLY_BUSINESS_TIMEZONE;
  const originalBusiness = process.env.BUSINESS_TIMEZONE;
  const originalTz = process.env.TZ;

  process.env.SHIFTLY_BUSINESS_TIMEZONE = 'Europe/Berlin';
  process.env.BUSINESS_TIMEZONE = 'UTC';
  process.env.TZ = 'America/New_York';

  assert.equal(getBusinessTimezone(), 'Europe/Berlin');

  if (originalShiftly == null) delete process.env.SHIFTLY_BUSINESS_TIMEZONE;
  else process.env.SHIFTLY_BUSINESS_TIMEZONE = originalShiftly;
  if (originalBusiness == null) delete process.env.BUSINESS_TIMEZONE;
  else process.env.BUSINESS_TIMEZONE = originalBusiness;
  if (originalTz == null) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

test('shift request maintenance defaults to enabled batches', () => {
  const originalEnabled = process.env.SHIFT_REQUEST_EXPIRATION_ENABLED;
  const originalInterval = process.env.SHIFT_REQUEST_EXPIRATION_INTERVAL_MS;
  const originalBatch = process.env.SHIFT_REQUEST_EXPIRATION_BATCH_SIZE;

  delete process.env.SHIFT_REQUEST_EXPIRATION_ENABLED;
  delete process.env.SHIFT_REQUEST_EXPIRATION_INTERVAL_MS;
  delete process.env.SHIFT_REQUEST_EXPIRATION_BATCH_SIZE;

  const config = getMaintenanceConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.intervalMs, 60000);
  assert.equal(config.batchSize, 100);

  process.env.SHIFT_REQUEST_EXPIRATION_ENABLED = 'false';
  assert.equal(getMaintenanceConfig().enabled, false);

  if (originalEnabled == null) delete process.env.SHIFT_REQUEST_EXPIRATION_ENABLED;
  else process.env.SHIFT_REQUEST_EXPIRATION_ENABLED = originalEnabled;
  if (originalInterval == null) delete process.env.SHIFT_REQUEST_EXPIRATION_INTERVAL_MS;
  else process.env.SHIFT_REQUEST_EXPIRATION_INTERVAL_MS = originalInterval;
  if (originalBatch == null) delete process.env.SHIFT_REQUEST_EXPIRATION_BATCH_SIZE;
  else process.env.SHIFT_REQUEST_EXPIRATION_BATCH_SIZE = originalBatch;
});
