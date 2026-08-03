const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const routePath = path.resolve(__dirname, '..', 'query', 'mobileDashboard.js');
const migrationPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'DB',
  'migrations',
  '20260803_mobile_dashboard_multiple_managers.sql',
);

test('mobile dashboard includes the scoped managers function', () => {
  const source = fs.readFileSync(routePath, 'utf8');

  assert.match(source, /shiftly_api\.fn_mobile_dashboard_managers\(\$1::int\) AS managers/);
  assert.match(source, /\$8::jsonb AS managers/);
});

test('mobile dashboard serializes manager arrays before binding to jsonb', () => {
  const source = fs.readFileSync(routePath, 'utf8');

  assert.match(source, /JSON\.stringify\(baseRow\.managers \?\? \[\]\)/);
  assert.doesNotMatch(source, /baseRow\.managers \?\? \[\],/);
});

test('mobile dashboard manager migration defines the full replacement function', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.fn_mobile_dashboard_managers/i);
  assert.match(sql, /FROM shiftly_schema\.user_managers um/i);
  assert.match(sql, /JSONB_AGG/i);
  assert.match(sql, /'scopes', mg\.scopes/i);
  assert.match(sql, /ALTER FUNCTION shiftly_api\.fn_mobile_dashboard_managers\(integer\)\s+OWNER TO shiftly_schema/i);
});
