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
  'day_details_request_workflow_owner.sql',
);

const shiftRequestsRoutePath = path.resolve(
  __dirname,
  '..',
  'routes',
  'shiftRequests.js',
);

const shiftRequestModelPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'lib',
  'models',
  'shift_request.dart',
);

const dayDetailsScreenPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'lib',
  'home',
  'mobile',
  'shift_screens',
  'mobile_shift_action_screen',
  'sub_screens',
  'day_details_screen.dart',
);

const requestNewShiftScreenPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'lib',
  'home',
  'mobile',
  'shift_screens',
  'mobile_shift_action_screen',
  'sub_screens',
  'request_new_shift_screen.dart',
);

const switchShiftScreenPath = path.resolve(
  __dirname,
  '..',
  '..',
  'shiftly',
  'lib',
  'home',
  'mobile',
  'shift_screens',
  'mobile_shift_action_screen',
  'sub_screens',
  'switch_shift_screen.dart',
);

test('day details migration returns pending request workflow owner labels', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION shiftly_api\.fn_mobile_day_details/i);
  assert.match(sql, /LEFT JOIN shiftly_schema\.users inbox_user/i);
  assert.match(sql, /LEFT JOIN shiftly_schema\.users manager_user/i);
  assert.match(sql, /COALESCE\(sr\.inbox_user_id,\s*sr\.manager_user_id\) AS workflow_owner_user_id/i);
  assert.match(sql, /workflow_owner_user_desc/i);
  assert.match(sql, /jsonb_agg\(to_jsonb\(sr\)/i);
});

test('shift request API includes current workflow owner labels in request responses', () => {
  const source = fs.readFileSync(shiftRequestsRoutePath, 'utf8');

  assert.match(source, /SHIFT_REQUEST_RESPONSE_SELECT/);
  assert.match(source, /manager_user\.user_desc AS manager_user_desc/);
  assert.match(source, /inbox_user\.user_desc AS inbox_user_desc/);
  assert.match(source, /workflow_owner_user\.user_name AS workflow_owner_user_name/);
  assert.match(source, /fetchShiftRequestResponse\(pool,\s*result\.rows\[0\]\?\.id/s);
});

test('Flutter shift request model parses workflow owner fields safely', () => {
  const source = fs.readFileSync(shiftRequestModelPath, 'utf8');

  assert.match(source, /final int\? workflowOwnerUserId/);
  assert.match(source, /json\['workflow_owner_user_desc'\] as String\?/);
  assert.match(source, /'workflow_owner_user_desc': workflowOwnerUserDesc/);
  assert.match(source, /String\? get workflowOwnerDisplayName/);
});

test('day-details reloads authoritative payload after successful request mutations', () => {
  const source = fs.readFileSync(dayDetailsScreenPath, 'utf8');

  assert.match(source, /Future<void> _reloadCurrentDay/);
  assert.match(source, /fetchMobileDayDetails\(userId: widget\.loggedUser\.id, date: dayKey\)/);
  assert.match(source, /await _reloadCurrentDayAfterSuccessfulMutation/);
  assert.match(source, /Received by: \$recipient/);
  assert.match(source, /Navigator\.of\(context\)\.pop\(_hasAuthoritativeChange\)/);
});

test('request creation child screens return success only after API success', () => {
  const requestNewShiftSource = fs.readFileSync(requestNewShiftScreenPath, 'utf8');
  const switchShiftSource = fs.readFileSync(switchShiftScreenPath, 'utf8');

  assert.match(requestNewShiftSource, /await context\s*\.[\s\S]*createRequest\(/);
  assert.match(requestNewShiftSource, /Navigator\.of\(context\)\.pop\(true\)/);
  assert.match(switchShiftSource, /await context\s*\.[\s\S]*createRequest\(/);
  assert.match(switchShiftSource, /Navigator\.of\(context\)\.pop\(true\)/);
});
