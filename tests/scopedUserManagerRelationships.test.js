const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'DB',
  'scoped_user_manager_relationships.sql',
);

const shiftRequestsRoutePath = path.resolve(
  __dirname,
  '..',
  'routes',
  'shiftRequests.js',
);

const userManagersRoutePath = path.resolve(
  __dirname,
  '..',
  'routes',
  'userManagers.js',
);

test('scoped user-manager migration defines the scoped source-of-truth objects', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ALTER TABLE shiftly_schema\.user_managers[\s\S]*ADD COLUMN IF NOT EXISTS division_id/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS department_id/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS uq_user_manager/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_user_manager_scope/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_user_manager_scope_primary/i);
  assert.match(sql, /v_user_manager_scope_migration_diagnostics/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.user_manager_scope_is_valid/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.get_scoped_manager_id/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.get_primary_manager_id/i);
});

test('scoped user-manager migration guards workflow and dashboard queries by division and department', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.trg_shift_requests_validate_scoped_manager/i);
  assert.match(sql, /CREATE TRIGGER trg_shift_requests_validate_scoped_manager/i);
  assert.match(sql, /um\.division_id = NEW\.division_id/i);
  assert.match(sql, /um\.department_id = NEW\.requested_department_id/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.fn_manager_dashboard/i);
  assert.match(sql, /ms\.division_id = a\.division_id/i);
  assert.match(sql, /ms\.department_id = a\.department_id/i);
});

test('shift request route derives manager scope server-side and ignores client manager ids', () => {
  const source = fs.readFileSync(shiftRequestsRoutePath, 'utf8');

  assert.match(source, /delete requestBody\.manager_user_id/);
  assert.match(source, /delete requestBody\.managerUserId/);
  assert.match(source, /set_config\('shiftly\.request_division_id'/);
  assert.match(source, /set_config\('shiftly\.workflow_request_id'/);
  assert.match(source, /um\.division_id = sr\.division_id/);
  assert.match(source, /um\.department_id = sr\.requested_department_id/);
});

test('user-manager route writes scoped mappings and calls scoped database validators', () => {
  const source = fs.readFileSync(userManagersRoutePath, 'utf8');

  assert.match(source, /'division_id'/);
  assert.match(source, /'department_id'/);
  assert.match(source, /validate_user_manager_create\(\s*\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5\s*\)/s);
  assert.match(source, /validate_user_manager_change\(\s*\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*\$7,\s*\$8\s*\)/s);
  assert.match(source, /apply_user_manager_change_to_shift_requests\(\s*\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*\$7\s*\)/s);
});
