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
  'shift_period_group_capacity_redesign.sql',
);

const shiftAssignmentsRoutePath = path.resolve(
  __dirname,
  '..',
  'routes',
  'shiftAssignments.js',
);

const assignmentRepositoryPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'lib',
  'repositories',
  'shift_assignment_repository.dart',
);

test('group capacity migration defines the normalized source of truth', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS shiftly_schema\.shift_assignment_capacity_groups/i);
  assert.match(sql, /CONSTRAINT uq_shift_assignment_capacity_group\s+UNIQUE\s*\(\s*shift_period_id,\s*shift_date,\s*division_id,\s*department_id,\s*staff_type_id,\s*shift_type_id\s*\)/i);
  assert.match(sql, /required_staff_count integer NOT NULL/i);
  assert.match(sql, /pending_required_staff_count integer/i);
  assert.match(sql, /staff_shift_rule_id integer/i);
});

test('group capacity migration defaults from one active staff shift rule and fails on ambiguity', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.ensure_shift_assignment_capacity_group/i);
  assert.match(sql, /FROM shiftly_schema\.staff_shift_rules r/i);
  assert.match(sql, /r\.division_id = p_division_id/i);
  assert.match(sql, /r\.department_id = p_department_id/i);
  assert.match(sql, /r\.staff_type_id = p_staff_type_id/i);
  assert.match(sql, /r\.shift_type_id = p_shift_type_id/i);
  assert.match(sql, /IF v_rule_count = 0 THEN/i);
  assert.match(sql, /IF v_rule_count > 1 THEN/i);
});

test('capacity migration enforces approved capacity and rewires availability consumers', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const availableFn = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION shiftly_api.fn_available_shift_options'),
    sql.indexOf('CREATE OR REPLACE VIEW shiftly_schema.vw_search_available_shifts'),
  );
  const searchView = sql.slice(
    sql.indexOf('CREATE OR REPLACE VIEW shiftly_schema.vw_search_available_shifts'),
    sql.indexOf('COMMIT;'),
  );

  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.trg_shift_assignments_prevent_capacity_overflow/i);
  assert.match(sql, /CREATE TRIGGER trg_shift_assignments_prevent_capacity_overflow/i);
  assert.match(sql, /upper\(coalesce\(sa\.status, ''\)\) = 'APPROVED'/i);
  assert.match(sql, /v_existing_approved \+ 1 > v_group\.required_staff_count/i);
  assert.match(availableFn, /FROM shiftly_schema\.shift_assignment_capacity_groups g/i);
  assert.match(searchView, /FROM shiftly_schema\.shift_assignment_capacity_groups g/i);
  assert.doesNotMatch(availableFn, /max\(sa\.assignment_required_staff_count\)/i);
  assert.doesNotMatch(searchView, /max\(a\.assignment_required_staff_count\)/i);
});

test('shift assignment API rejects per-assignment capacity writes and exposes group endpoints', () => {
  const source = fs.readFileSync(shiftAssignmentsRoutePath, 'utf8');

  assert.match(source, /router\.put\('\/capacity-groups'/);
  assert.match(source, /router\.post\('\/capacity-groups\/:id\/approve'/);
  assert.match(source, /Required staff count is edited at the shift group level/);
  assert.match(source, /shiftly_api\.update_shift_assignment_capacity_group/);
  assert.match(source, /shiftly_api\.approve_shift_assignment_capacity_group/);
});

test('Flutter repository sends capacity changes through group endpoint only', () => {
  const source = fs.readFileSync(assignmentRepositoryPath, 'utf8');

  assert.match(source, /Future<Map<String, dynamic>> updateCapacityGroup/);
  assert.match(source, /Future<Map<String, dynamic>> approveCapacityGroup/);
  assert.match(source, /'required_staff_count': requiredStaffCount/);
  assert.doesNotMatch(source, /'assignment_required_staff_count':/);
});
