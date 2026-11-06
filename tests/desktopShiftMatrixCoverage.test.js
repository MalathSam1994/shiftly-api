const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function load(file, resolve) {
  const sandbox = { module: { exports: {} }, require: resolve, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox);
  return sandbox.module.exports;
}
const scope = load('utils/shiftPeriodScope.js', () => ({}));
const requests = load('query/shiftPeriodRequests.js', () => scope);
const overview = load('query/shiftPeriodOverview.js', name => name === './shiftPeriodRequests' ? requests : scope);
const { desktopShiftMatrixCoverageSql } = load('query/desktopShiftMatrixCoverage.js', name =>
  name === './shiftPeriodOverview' ? overview : scope);

function harness(payload = { rows: [], scope_available: true }) {
  const handlers = new Map(); const calls = [];
  load('query/desktopShiftMatrixSearch.js', name => {
    if (name === 'express') return { Router: () => ({ get: (url, fn) => handlers.set(url, fn) }) };
    if (name === '../db') return { query: async (...args) => { calls.push(args); return { rows: payload == null ? [] : [{ payload }] }; } };
    if (name === './desktopShiftMatrixCoverage') return { desktopShiftMatrixCoverageSql };
    if (name === '../utils/shiftlyRuntimeConfig') return { getBusinessTimezone: () => 'Europe/Berlin' };
    return {};
  });
  return { calls, run: async (query = {}, user = { sub: '31' }, endpoint = '/coverage') => {
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }, setHeader(key, value) { this.headers[key] = value; } };
    await handlers.get(endpoint)({ query: { from: '2026-11-01', to: '2026-12-01', ...query }, user }, res);
    return res;
  } };
}

test('coverage authenticates from session, strictly validates dates and filters before SQL', async () => {
  const h = harness();
  assert.equal((await h.run({}, null)).statusCode, 401);
  for (const query of [
    { from: '2026-02-30' }, { from: '2026-11-01junk' }, { to: '2026-11-01' },
    { to: '2030-01-01' }, { departmentId: '1junk' }, { userId: '-1' },
    { divisionId: ['1', '2'] }, { staffTypeId: '2147483648' }, { status: ['APPROVED'] },
  ]) assert.equal((await h.run(query)).statusCode, 400, JSON.stringify(query));
  assert.equal(h.calls.length, 0);
  const result = await h.run({ loggedUserId: '999', divisionId: '2', departmentId: '3',
    staffTypeId: '4', shiftTypeId: '5', userId: '6', status: 'PENDING' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Array.from(h.calls[0][1]), [31, '2026-11-01', '2026-12-01', 2, 3, 4, 5, 6, 'PENDING', 'Europe/Berlin']);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('coverage distinguishes restricted metadata and inactive actor from authorized empty results', async () => {
  assert.equal((await harness(null).run()).statusCode, 403);
  const restricted = { rows: [], scope_available: false, summary: { total_groups: 0 } };
  assert.equal((await harness(restricted).run()).body, restricted);
});

test('search and both exports preserve required date boundaries before SQL', async () => {
  const h = harness();
  for (const endpoint of ['/', '/excel', '/excel-matrix']) {
    for (const query of [{ from: null }, { to: null }]) {
      assert.equal((await h.run(query, { sub: '1' }, endpoint)).statusCode, 400);
    }
  }
  assert.equal(h.calls.length, 0);
});

test('coverage SQL keeps parent overview defaults and explicitly binds its lateral actor', () => {
  assert.match(overview.shiftPeriodOverviewSql, /sp\.id = \$1/);
  assert.match(overview.shiftPeriodOverviewSql, /sr\.inbox_user_id = \$2/);
  assert.doesNotMatch(overview.shiftPeriodOverviewSql, /'coverage_groups'/);
  assert.match(desktopShiftMatrixCoverageSql, /sp\.id = selected_period\.id/);
  assert.match(desktopShiftMatrixCoverageSql, /sr\.inbox_user_id = \$1/);
  assert.match(desktopShiftMatrixCoverageSql, /NULLIF\(\$10::text/);
  assert.match(desktopShiftMatrixCoverageSql, /fn_roster_occupied_places/);
});

// The guarded fixture server is disposable, never the application database.
test('coverage SQL: scoped empty groups, exact occupancy, filters, unknown rules and historical census', {
  skip: process.env.RUN_SHIFT_PERIOD_SQL_TESTS !== '1', timeout: 240000,
}, async t => {
  const { Client } = require('pg');
  const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/17/bin';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-search-coverage-'));
  const data = path.join(temp, 'data'); const port = 55441;
  const command = (name, args) => {
    const result = spawnSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args,
      { windowsHide: true, encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, `${name}: ${result.error || ''} ${result.stderr} ${result.stdout}`);
  };
  let started = false;
  const db = new Client({ host: '127.0.0.1', port, user: 'coverage_test', database: 'postgres' });
  try {
    command('initdb', ['-D', data, '-A', 'trust', '-U', 'coverage_test', '--encoding=UTF8', '--no-locale', '--no-sync']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true; await db.connect();
    await db.query(fs.readFileSync(path.join(__dirname, 'fixtures/shiftPeriodOverview.sql'), 'utf8'));
    const migration = fs.readFileSync(path.join(__dirname, '../../shiftly/DB/migrations/20260924_attention_consolidation.sql'), 'utf8');
    await db.query(migration.match(/CREATE OR REPLACE FUNCTION shiftly_api\.fn_roster_occupied_places\([\s\S]*?\$\$;/i)[0]);
    await db.query(`
      CREATE TABLE shiftly_schema.divisions (id int, division_desc text);
      CREATE TABLE shiftly_schema.departments (id int, department_desc text);
      INSERT INTO shiftly_schema.divisions VALUES (1,'Central'),(2,'West');
      INSERT INTO shiftly_schema.departments VALUES (1,'ICU'),(2,'ED');
      CREATE FUNCTION shiftly_api.fn_desktop_shift_matrix_search(actor int, dfrom date, dto date,
        division int, department int, staff int, shift int, person int, state varchar)
      RETURNS TABLE(shift_assignment_id int, shift_period_id int, shift_date date,
        division_id int, department_id int, staff_type_id int, shift_type_id int)
      LANGUAGE sql STABLE AS $$ SELECT a.id, a.shift_period_id, a.shift_date, a.division_id,
        a.department_id, a.staff_type_id, a.shift_type_id FROM shiftly_schema.shift_assignments a
        WHERE actor=1 AND a.shift_date >= dfrom AND a.shift_date < dto
          AND (division IS NULL OR a.division_id=division) AND (department IS NULL OR a.department_id=department)
          AND (staff IS NULL OR a.staff_type_id=staff) AND (shift IS NULL OR a.shift_type_id=shift)
          AND (person IS NULL OR a.user_id=person) AND (state IS NULL OR a.status=state) $$;
    `);
    const date = (await db.query("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS today, to_char(CURRENT_DATE+1,'YYYY-MM-DD') AS tomorrow, to_char(CURRENT_DATE+2,'YYYY-MM-DD') AS day_after")).rows[0];
    const query = async ({ actor = 1, person = null, status = null, department = null } = {}) =>
      (await db.query(desktopShiftMatrixCoverageSql, [actor, date.today, date.tomorrow, null, department, null, null, person, status, 'UTC'])).rows[0]?.payload;
    await t.test('configured but unstaffed day and night groups are present', async () => {
      const result = await query(); assert.equal(result.rows.length, 2);
      assert.ok(result.rows.every(r => r.assigned_staff === 0 && r.coverage_status === 'UNCOVERED'));
      assert.equal(result.summary.missing_staff, 12); assert.equal(result.summary.missing_shifts, 2);
      assert.equal(result.summary.coverage_percent, 0); assert.equal(result.scope_available, true);
      assert.equal(result.rows[0].patient_count, null);
    });
    await t.test('status and assignee filters select whole groups without lowering coverage', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_assignments
        (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,user_id)
        VALUES (11,1,CURRENT_DATE,1,1,1,1,'APPROVED',2,11),
        (12,1,CURRENT_DATE,1,1,1,1,'DRAFT',2,12),
        (13,1,CURRENT_DATE,1,1,1,1,'CANCELLED',2,13),
        (14,1,CURRENT_DATE,1,1,1,1,'APPROVED',1,14)`);
      const result = await query({ person: 11, status: 'APPROVED' });
      assert.equal(result.rows.length, 1); assert.equal(result.rows[0].assigned_staff, 2);
      assert.equal(result.rows[0].approved_staff, 1); assert.equal(result.rows[0].gap, 6);
      assert.deepEqual(result.rows[0].assignment_ids, [11]);
    });
    await t.test('effective saved group overrides rules and unapproved pending capacity', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_assignment_capacity_groups
        VALUES (91,1,CURRENT_DATE,1,1,1,1,1,10,'PENDING')`);
      const row = (await query()).rows.find(r => r.shift_type_id === 1);
      assert.equal(row.required_staff, 1); assert.equal(row.excess, 1);
      assert.equal(row.coverage_status, 'OVERSTAFFED'); assert.equal(row.capacity_group_id, 91);
    });
    await t.test('ambiguous requirements stay unknown', async () => {
      await db.query("INSERT INTO shiftly_schema.staff_shift_rules VALUES (9,1,1,1,2,7,true)");
      const result = await query(); const night = result.rows.find(r => r.shift_type_id === 2);
      assert.equal(night.required_staff, null); assert.equal(night.gap, null);
      assert.equal(night.coverage_status, 'UNKNOWN'); assert.equal(result.summary.unknown, 1);
    });
    await t.test('own-only actor gets explicit unavailable scope; manager gets only managed organization', async () => {
      const own = await query({ actor: 2 });
      assert.equal(own.scope_available, false); assert.deepEqual(own.rows, []);
      await db.query(`INSERT INTO shiftly_schema.user_managers VALUES (2,1,1,true);
        INSERT INTO shiftly_schema.shift_periods VALUES (2,CURRENT_DATE,CURRENT_DATE+1,2,2,'GENERATED');
        INSERT INTO shiftly_schema.staff_shift_rules VALUES (20,2,2,1,1,4,true)`);
      const managed = await query({ actor: 2 }); assert.equal(managed.scope_available, true);
      assert.ok(managed.rows.every(r => r.department_id === 1));
      assert.equal((await query({ actor: 2, department: 2 })).rows.length, 0);
      assert.ok((await query()).rows.some(r => r.department_id === 2));
      assert.ok(managed.rows.every(r => !r.can_manage && r.patient_count === null));
    });
    await t.test('patient changes use historical authorized census, with no fabricated future data', async () => {
      await db.query(`INSERT INTO shiftly_schema.clinical_encounters
        SELECT n,1,1,'ACTIVE',CURRENT_DATE-10,NULL FROM generate_series(1,5) n;
        INSERT INTO shiftly_schema.clinical_encounter_locations
        SELECT n,n,1,1,CURRENT_DATE-10,NULL FROM generate_series(1,5) n;
        INSERT INTO shiftly_schema.clinical_encounters
        SELECT n,1,1,'ACTIVE',CURRENT_DATE,NULL FROM generate_series(6,9) n;
        INSERT INTO shiftly_schema.clinical_encounter_locations
        SELECT n,n,1,1,CURRENT_DATE,NULL FROM generate_series(6,9) n;`);
      const result = await query(); const rows = result.rows.filter(r => r.department_id === 1);
      assert.ok(rows.every(r => r.patient_count === 9 && r.patient_baseline === 5));
      assert.ok(rows.every(r => r.patient_change_percent === 80 && r.patient_alert));
      assert.equal(result.summary.patient_changes, 1, 'same department/day alert is counted once across shifts');
      const future = (await db.query(desktopShiftMatrixCoverageSql,
        [1, date.tomorrow, date.day_after, null, null, null, null, null, null, 'UTC'])).rows[0]?.payload;
      assert.ok(future.rows.length > 0);
      assert.ok(future.rows.every(r => r.shift_date === date.tomorrow && r.patient_count === null && !r.patient_alert));
    });
    await t.test('bounded coverage equals the full overview while retaining earlier roster evidence and census', async () => {
      const options = {
        periodReference: 'selected_period.id', actorIndex: 1,
        timezoneReference: '$10', periodScopeSql: 'true', includeCoverageGroups: true,
      };
      const trimSql = sql => sql.trim().replace(/;$/, '');
      const optimizedSnapshot = trimSql(overview.buildShiftPeriodOverviewSql({
        ...options, fromReference: '$2', toReference: '$3', coverageOnly: true,
      }));
      const fullSnapshot = trimSql(overview.buildShiftPeriodOverviewSql(options));
      const referenceSql = desktopShiftMatrixCoverageSql.replace(optimizedSnapshot, fullSnapshot);
      assert.notEqual(referenceSql, desktopShiftMatrixCoverageSql);
      await db.query('BEGIN');
      try {
        await db.query(`
          UPDATE shiftly_schema.shift_periods SET start_date=CURRENT_DATE-90, end_date=CURRENT_DATE+90 WHERE id=1;
          INSERT INTO shiftly_schema.shift_types VALUES (9,'20:00','08:00','ANY',true,'Night alternate','NA');
          INSERT INTO shiftly_schema.staff_shift_rules VALUES (99,1,1,1,9,3,true);
          INSERT INTO shiftly_schema.shift_assignment_capacity_groups
            VALUES (99,1,CURRENT_DATE-45,1,1,1,9,3,NULL,NULL);
        `);
        for (const [person, status] of [[null, null], [11, 'APPROVED']]) {
          const values = [1, date.today, date.tomorrow, null, null, null, null, person, status, 'UTC'];
          const optimized = (await db.query(desktopShiftMatrixCoverageSql, values)).rows[0].payload;
          const reference = (await db.query(referenceSql, values)).rows[0].payload;
          assert.deepEqual(optimized, reference, 'requested days retain full-period authoritative results');
          if (person == null) {
            assert.ok(optimized.rows.some(row => row.shift_type_id === 9), 'out-of-range roster evidence still defines the expected pattern');
            assert.ok(optimized.rows.filter(row => row.department_id === 1).every(row => row.patient_baseline === 5));
          }
        }
        const values = [1, date.today, date.tomorrow, null, null, null, null, null, null, 'UTC'];
        for (const [label, sql] of [['bounded coverage', desktopShiftMatrixCoverageSql], ['full overview reference', referenceSql]]) {
          const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${sql}`, values)).rows[0]['QUERY PLAN'][0];
          t.diagnostic(`${label} fixture execution: ${plan['Execution Time']} ms`);
        }
      } finally {
        await db.query('ROLLBACK');
      }
    });
    await t.test('search and coverage share stored business dates at month boundaries across database timezones', async () => {
      // Exercise the real legacy search function, including its timezone cast,
      // rather than mocking away the date conversion that caused the mismatch.
      await db.query(`
        ALTER TABLE shiftly_schema.users ADD COLUMN empno text;
        ALTER TABLE shiftly_schema.user_managers ADD COLUMN user_id int;
        ALTER TABLE shiftly_schema.shift_assignments ADD COLUMN source_type text;
        ALTER TABLE shiftly_schema.shift_assignments ADD COLUMN absence_type text;
        ALTER TABLE shiftly_schema.shift_assignments ADD COLUMN is_charge_nurse boolean DEFAULT false;
        CREATE FUNCTION shiftly_api.fn_assignment_duration_hours(time,time) RETURNS numeric
          LANGUAGE sql AS 'SELECT 12::numeric';
        CREATE FUNCTION shiftly_api.fn_shift_assignment_can_be_charge(integer) RETURNS boolean
          LANGUAGE sql AS 'SELECT false';
        DROP FUNCTION shiftly_api.fn_desktop_shift_matrix_search(integer,date,date,integer,integer,integer,integer,integer,varchar);
        INSERT INTO shiftly_schema.users VALUES (91,1,true,'boundary_user','Boundary User','91');
        INSERT INTO shiftly_schema.shift_periods VALUES (99,'2026-10-31','2026-12-01',1,1,'APPROVED');
        INSERT INTO shiftly_schema.shift_assignments
          (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,
           status,is_absence,start_time,end_time,user_id,source_type)
        VALUES (901,99,'2026-11-01',1,1,1,1,'APPROVED',2,'07:00','19:00',91,'MANUAL'),
          (902,99,'2026-11-30',1,1,1,1,'APPROVED',2,'07:00','19:00',91,'MANUAL'),
          (903,99,'2026-10-31',1,1,1,1,'APPROVED',2,'07:00','19:00',91,'MANUAL'),
          (904,99,'2026-12-01',1,1,1,1,'APPROVED',2,'07:00','19:00',91,'MANUAL');
      `);
      const baseline = fs.readFileSync(path.join(__dirname, '../../shiftly/DB/shiftly.sql'), 'utf8');
      const legacy = baseline.match(/CREATE FUNCTION shiftly_api\.fn_desktop_shift_matrix_search\([\s\S]*?\$\$;/i);
      assert.ok(legacy, 'database baseline supplies the legacy scoped search function');
      await db.query(legacy[0]);
      const legacyDaySql = `SELECT to_char(shift_date,'YYYY-MM-DD') AS day
        FROM shiftly_api.fn_desktop_shift_matrix_search(1,'2026-10-30','2026-12-03',NULL,NULL,NULL,NULL,91,NULL)
        WHERE shift_assignment_id=901`;
      assert.equal((await db.query(legacyDaySql)).rows[0].day, '2026-11-01',
        'legacy conversion is unchanged under UTC');
      await db.query("SET TIME ZONE 'Pacific/Auckland'");
      assert.equal((await db.query(legacyDaySql)).rows[0].day, '2026-10-31',
        'legacy conversion changes civil date in a session east of the business timezone');
      const h = harness();
      await h.run({ userId: '91', status: 'APPROVED' }, { sub: '1' }, '/');
      const [searchSql, searchValues] = h.calls[0];
      for (const timezone of ['UTC', 'Pacific/Auckland']) {
        await db.query('SELECT set_config(\'TimeZone\',$1,false)', [timezone]);
        const searchRows = (await db.query(searchSql, Array.from(searchValues))).rows;
        assert.deepEqual(searchRows.map(r => [r.shift_assignment_id, r.shift_date]),
          [[901, '2026-11-01'], [902, '2026-11-30']], 'include raw start date and exclude raw exclusive end');
        const coverage = (await db.query(desktopShiftMatrixCoverageSql,
          [1, '2026-11-01', '2026-12-01', null, null, null, null, 91, 'APPROVED', 'Europe/Berlin'])).rows[0].payload;
        assert.deepEqual(coverage.rows.map(r => [r.assignment_ids[0], r.shift_date]),
          searchRows.map(r => [r.shift_assignment_id, r.shift_date]));
        // Padding must never broaden authorization while recovering boundary IDs.
        const restrictedValues = Array.from(searchValues); restrictedValues[0] = 2;
        assert.equal((await db.query(searchSql, restrictedValues)).rows.length, 0);
      }
    });
  } finally {
    try { await db.end(); } catch (_) {}
    if (started) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    // Remove only this test-created, verified temporary directory.
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
