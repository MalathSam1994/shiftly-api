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
  'fix_division_department_description_consistency.sql',
);

const divisionDepartmentsRoutePath = path.resolve(
  __dirname,
  '..',
  'routes',
  'division_departments.js',
);

const shiftPeriodsRoutePath = path.resolve(
  __dirname,
  '..',
  'routes',
  'shiftPeriods.js',
);

const flutterRepositoryPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'lib',
  'repositories',
  'division_department_repository.dart',
);

test('division department consistency migration uses canonical names in dropdown view', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE VIEW shiftly_schema\.v_dropdown_div_dep AS/i);
  assert.match(sql, /JOIN shiftly_schema\.divisions d\s+ON d\.id = dd\.division_id/i);
  assert.match(sql, /JOIN shiftly_schema\.departments dep\s+ON dep\.id = dd\.department_id/i);
  assert.match(sql, /d\.division_desc/i);
  assert.match(sql, /dep\.department_desc/i);
  assert.match(sql, /dd\.is_active/i);
});

test('division department consistency migration repairs and synchronizes copied descriptions', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /UPDATE shiftly_schema\.division_departments dd/i);
  assert.match(sql, /dd\.division_desc IS DISTINCT FROM d\.division_desc/i);
  assert.match(sql, /dd\.department_desc IS DISTINCT FROM dep\.department_desc/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_schema\.fn_division_departments_set_canonical_desc/i);
  assert.match(sql, /CREATE TRIGGER trg_division_departments_set_canonical_desc/i);
  assert.match(sql, /CREATE TRIGGER trg_divisions_sync_division_departments_desc/i);
  assert.match(sql, /CREATE TRIGGER trg_departments_sync_division_departments_desc/i);
});

test('division department route no longer trusts copied names from the client', () => {
  const source = fs.readFileSync(divisionDepartmentsRoutePath, 'utf8');

  assert.doesNotMatch(source, /req\.body\.division_desc/);
  assert.doesNotMatch(source, /req\.body\.department_desc/);
  assert.doesNotMatch(source, /VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
  assert.match(source, /JOIN shiftly_schema\.departments dep ON dep\.id = \$2/);
});

test('Flutter division department repository sends relationship ids only', () => {
  const source = fs.readFileSync(flutterRepositoryPath, 'utf8');

  assert.match(source, /'division_id': division\.id/);
  assert.match(source, /'department_id': department\.id/);
  assert.doesNotMatch(source, /'division_desc':/);
  assert.doesNotMatch(source, /'department_desc':/);
});

test('shift period responses prefer canonical division and department names', () => {
  const source = fs.readFileSync(shiftPeriodsRoutePath, 'utf8');

  assert.match(source, /dv\.division_desc AS division_desc/);
  assert.match(source, /dep\.department_desc AS department_desc/);
  assert.doesNotMatch(source, /COALESCE\(dd\.division_desc,\s*dv\.division_desc\)/);
  assert.doesNotMatch(source, /COALESCE\(dd\.department_desc,\s*dep\.department_desc\)/);
});
