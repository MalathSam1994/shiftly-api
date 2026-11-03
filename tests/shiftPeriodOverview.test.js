const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function loadModule(file, resolve) {
  const sandbox = { module: { exports: {} }, require: resolve, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox);
  return sandbox.module.exports;
}
const scope = loadModule('utils/shiftPeriodScope.js', () => ({}));
const requestQueries = loadModule('query/shiftPeriodRequests.js', () => scope);
const { shiftPeriodRequestsSql } = requestQueries;
const { shiftPeriodOverviewSql } = loadModule('query/shiftPeriodOverview.js', name =>
  name === './shiftPeriodRequests' ? requestQueries : scope);

function routeHarness(rows = []) {
  const handlers = new Map();
  const calls = [];
  const router = { get: (url, fn) => handlers.set(url, fn), post() {}, put() {}, delete() {}, use() {} };
  loadModule('routes/shiftPeriods.js', name => {
    if (name === '../db') return { query: async (...args) => { calls.push(args); return { rows }; } };
    if (name === '../createCrudRouter') return () => router;
    if (name === '../utils/shiftPeriodScope') return scope;
    if (name === '../query/shiftPeriodOverview') return { shiftPeriodOverviewSql };
    if (name === '../query/shiftPeriodRequests') return requestQueries;
    if (name === '../utils/shiftlyRuntimeConfig') return { getBusinessTimezone: () => 'Europe/Berlin' };
    return {};
  });
  return { calls, run: async (id, user = { id: 1 }, endpoint = 'overview') => {
    const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get(`/:id/${endpoint}`)({ params: { id }, user }, res);
    return res;
  } };
}

test('overview rejects malformed IDs and unauthenticated reads before querying', async () => {
  const h = routeHarness();
  for (const id of ['1junk', '-1', '0', '1.5', '2147483648']) assert.equal((await h.run(id)).statusCode, 400);
  assert.equal((await h.run('1', null)).statusCode, 401);
  assert.equal(h.calls.length, 0);
});

test('overview uses one scoped query with actor and timezone; inaccessible periods are unavailable', async () => {
  const h = routeHarness();
  const unavailable = await h.run('7');
  assert.equal(unavailable.statusCode, 404);
  assert.equal(unavailable.headers['Cache-Control'], 'no-store');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Array.from(h.calls[0][1]), [7, 1, 'Europe/Berlin']);
  assert.equal(h.calls[0][0], shiftPeriodOverviewSql);
  const payload = { period_id: 7, days: [], total_assignments: 0 };
  assert.equal((await routeHarness([{ overview: payload }]).run('7')).body, payload);
});

test('period requests require authentication, exact period IDs and scoped query ownership', async () => {
  const h = routeHarness();
  for (const id of ['1junk', '-1', '0', '1.5', '2147483648']) {
    assert.equal((await h.run(id, { id: 1 }, 'requests')).statusCode, 400);
  }
  assert.equal((await h.run('1', null, 'requests')).statusCode, 401);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.run('7', { sub: 2 }, 'requests')).statusCode, 404);
  assert.deepEqual(Array.from(h.calls[0][1]), [7, 2]);
  assert.equal(h.calls[0][0], shiftPeriodRequestsSql);
  const payload = { period_id: 7, requests: [] };
  const result = await routeHarness([{ payload }]).run('7', { id: 1 }, 'requests');
  assert.equal(result.body, payload);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

// Run against a disposable local PostgreSQL, never the application's database.
// RUN_SHIFT_PERIOD_SQL_TESTS=1; optionally set PG_TEST_BIN to the PostgreSQL bin directory.
test('overview SQL: capacity, missing shifts, history and permission boundaries', {
  skip: process.env.RUN_SHIFT_PERIOD_SQL_TESTS !== '1', timeout: 240000,
}, async t => {
  const { Client } = require('pg');
  const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/17/bin';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-period-overview-'));
  const data = path.join(temp, 'data');
  const port = 55439;
  const command = (name, args) => {
    const result = spawnSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args,
      { windowsHide: true, encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, `${name}: ${result.error || ''} ${result.stderr} ${result.stdout}`);
  };
  let started = false;
  const db = new Client({ host: '127.0.0.1', port, user: 'overview_test', database: 'postgres' });
  try {
    command('initdb', ['-D', data, '-A', 'trust', '-U', 'overview_test', '--encoding=UTF8', '--no-locale', '--no-sync']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true;
    await db.connect();
    await db.query(fs.readFileSync(path.join(__dirname, 'fixtures', 'shiftPeriodOverview.sql'), 'utf8'));
    const migration = fs.readFileSync(path.join(__dirname, '../../shiftly/DB/migrations/20260924_attention_consolidation.sql'), 'utf8');
    const occupied = migration.match(/CREATE OR REPLACE FUNCTION shiftly_api\.fn_roster_occupied_places\([\s\S]*?\$\$;/i);
    assert.ok(occupied, 'Use the actual production occupied-place definition.');
    await db.query(occupied[0]);
    await db.query('BEGIN');
    const today = (await db.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS day")).rows[0].day;
    const overview = async (actor = 1) => (await db.query(shiftPeriodOverviewSql, [1, actor, 'UTC'])).rows[0]?.overview;
    const current = async (actor = 1) => (await overview(actor)).days.find(d => d.date === today);
    const requests = async (periodId = 1, actor = 1) =>
      (await db.query(shiftPeriodRequestsSql, [periodId, actor])).rows[0]?.payload;
    await t.test('zero-assigned rules create expected day and night capacity', async () => {
      const day = await current();
      assert.equal(day.day_assigned, 0); assert.equal(day.day_required, 8);
      assert.equal(day.night_assigned, 0); assert.equal(day.night_required, 4);
      assert.equal(day.night_missing, true);
    });
    await t.test('request-only days expose real workflow statuses and planned versus approved capacity', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one','Nurse One'),(12,1,true,'nurse_two','Nurse Two');
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,1),
            (102,'NEW_SHIFT','PENDING_TARGET_MANAGER',12,CURRENT_DATE,1,1,1,1);`);
        const day = await current();
        const shift = day.shifts.find(s => s.shift_type_id === 1);
        assert.equal(shift.assigned, 0); assert.equal(shift.planned, 2);
        assert.equal(shift.approved, 0); assert.equal(shift.pending_requests, 2);
        assert.equal(shift.required, 8); assert.equal(shift.missing, true);
        const rows = (await requests()).requests;
        assert.deepEqual(rows.map(r => r.request_status), ['PENDING', 'PENDING_TARGET_MANAGER']);
        assert.ok(rows.every(r => r.counts_as_place && r.assignment_id === null));
        assert.equal(rows[0].shift_date, today); assert.equal(rows[0].start_time, '07:00:00');
        assert.equal(rows[0].required_staff_count, 8); assert.equal(rows[0].user_name, 'nurse_one');
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('natural-slot and linked request matches count existing drafts once; approval replaces request cleanly', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one',NULL),(12,1,true,'nurse_two',NULL);
          INSERT INTO shiftly_schema.shift_assignments
            (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,user_id)
          VALUES (201,1,CURRENT_DATE,1,1,1,1,'DRAFT',2,11),(202,1,CURRENT_DATE,1,1,1,1,'APPROVED',2,12);
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id,shift_assignment_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,1,NULL),
            (102,'NEW_SHIFT','PENDING',12,CURRENT_DATE,1,1,1,1,202),
            (103,'NEW_SHIFT','PENDING_SOURCE_MANAGER',11,CURRENT_DATE,1,1,1,1,NULL);`);
        const shift = (await current()).shifts.find(s => s.shift_type_id === 1);
        assert.equal(shift.assigned, 2); assert.equal(shift.planned, 2);
        assert.equal(shift.approved, 1); assert.equal(shift.pending_requests, 0);
        assert.ok((await requests()).requests.every(r => !r.counts_as_place && r.assignment_id != null));
        // Linked annotations belong to the saved roster group even if the
        // requester's current staff type changed since that row was created.
        await db.query(`INSERT INTO shiftly_schema.staff_types VALUES (20,'Changed role',true);
          UPDATE shiftly_schema.users SET staff_type_id=20 WHERE id=11;`);
        assert.ok((await requests()).requests.filter(r => r.user_id === 11).every(r => r.staff_type_id === 1));
        await db.query(`UPDATE shiftly_schema.shift_requests SET request_status='APPROVED', inbox_user_id=NULL WHERE id IN (101,103);
          UPDATE shiftly_schema.shift_assignments SET status='APPROVED' WHERE id=201;`);
        const approved = (await current()).shifts.find(s => s.shift_type_id === 1);
        assert.equal(approved.planned, 2); assert.equal(approved.approved, 2);
        assert.deepEqual((await requests()).requests.map(r => r.id), [102]);
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('duplicate proposals add one place; switch, offer and off requests never add staffing', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one',NULL);
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,1),
            (102,'NEW_SHIFT','PENDING_TARGET_MANAGER',11,CURRENT_DATE,1,1,1,1),
            (103,'SWITCH','PENDING_SOURCE_MANAGER',11,CURRENT_DATE,1,1,1,1),
            (104,'OFFER','PENDING_REQUESTOR_MANAGER',11,CURRENT_DATE,1,1,1,1),
            (105,'OFF_REQUEST','PENDING',11,CURRENT_DATE,1,1,1,1);`);
        const rows = (await requests()).requests;
        assert.equal(rows.length, 5); assert.deepEqual(rows.filter(r => r.counts_as_place).map(r => r.id), [101]);
        const shift = (await current()).shifts.find(s => s.shift_type_id === 1);
        assert.equal(shift.planned, 1); assert.equal(shift.pending_requests, 1);
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('request visibility excludes other inboxes, organizations, dates and terminal decisions', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one',NULL);
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,1),
            (102,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,2),
            (103,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,2,1),
            (104,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,2,1,1),
            (105,'NEW_SHIFT','PENDING',11,CURRENT_DATE+30,1,1,1,1),
            (106,'NEW_SHIFT','REJECTED',11,CURRENT_DATE,1,1,1,1),
            (107,'NEW_SHIFT','CANCELLED',11,CURRENT_DATE,1,1,1,1),
            (108,'NEW_SHIFT','APPROVED',11,CURRENT_DATE,1,1,1,1);`);
        assert.deepEqual((await requests()).requests.map(r => r.id), [101]);
        assert.deepEqual((await requests(1, 2)).requests.map(r => r.id), [102]);
        assert.equal(await requests(1, 3), undefined);
        assert.equal((await current()).shifts.find(s => s.shift_type_id === 1).planned, 1);
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('one-day requests do not seed recurring shift patterns or claim clinical spillover', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one',NULL);
          INSERT INTO shiftly_schema.shift_types (id,start_time,end_time,day_type,is_active,shift_label,shift_code)
            VALUES (20,'15:00','23:00','ANY',true,'Afternoon 8h','AFTERNOON');
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,20,1,1,1);`);
        const data = await overview();
        const proposed = data.days.find(d => d.date === today).shifts.find(s => s.shift_type_id === 20);
        assert.equal(proposed.planned, 1); assert.equal(proposed.assigned, 0);
        assert.equal(proposed.approved, 0); assert.equal(proposed.required, null);
        assert.ok(data.days.filter(d => d.date !== today).every(d => !d.shifts.some(s => s.shift_type_id === 20)));
        assert.ok(data.days.every(d => d.spillover_count === 0));
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('cancelled or absence slots do not suppress an active proposal', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one',NULL),(12,1,true,'nurse_two',NULL);
          INSERT INTO shiftly_schema.shift_assignments
            (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,user_id)
          VALUES (201,1,CURRENT_DATE,1,1,1,1,'CANCELLED',2,11),(202,1,CURRENT_DATE,1,1,1,1,'APPROVED',1,12);
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id,shift_assignment_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,1,201),
            (102,'NEW_SHIFT','PENDING',12,CURRENT_DATE,1,1,1,1,202);`);
        const shift = (await current()).shifts.find(s => s.shift_type_id === 1);
        assert.equal(shift.assigned, 0); assert.equal(shift.planned, 2); assert.equal(shift.approved, 0);
        assert.ok((await requests()).requests.every(r => r.counts_as_place));
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('request period resolution follows approval, linked history and unambiguous draft fallback', async () => {
      await db.query('SAVEPOINT requests_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.users VALUES (11,1,true,'nurse_one',NULL);
          INSERT INTO shiftly_schema.shift_requests
            (id,request_type,request_status,requested_by_user_id,requested_shift_date,requested_shift_type_id,requested_department_id,division_id,inbox_user_id)
          VALUES (101,'NEW_SHIFT','PENDING',11,CURRENT_DATE,1,1,1,1);
          INSERT INTO shiftly_schema.shift_periods VALUES (2,CURRENT_DATE-1,CURRENT_DATE+1,1,1,'GENERATED');`);
        assert.equal((await requests(1)).requests.length, 1);
        assert.equal((await requests(2)).requests.length, 0);
        await db.query(`INSERT INTO shiftly_schema.shift_assignments
            (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,user_id)
          VALUES (201,2,CURRENT_DATE,1,1,1,1,'APPROVED',2,11);
          INSERT INTO shiftly_schema.shift_assignment_user_history VALUES (1,101,201,'NEW_SHIFT');`);
        assert.equal((await requests(1)).requests.length, 0);
        const linked = (await requests(2)).requests[0];
        assert.equal(linked.assignment_id, 201); assert.equal(linked.counts_as_place, false);
        await db.query(`DELETE FROM shiftly_schema.shift_assignment_user_history;
          DELETE FROM shiftly_schema.shift_assignments WHERE id=201;
          UPDATE shiftly_schema.shift_periods SET status='DRAFT';`);
        assert.equal((await requests(1)).requests.length, 0);
        assert.equal((await requests(2)).requests.length, 0);
        await db.query('DELETE FROM shiftly_schema.shift_periods WHERE id=2');
        assert.equal((await requests(1)).requests.length, 1);
      } finally { await db.query('ROLLBACK TO SAVEPOINT requests_case'); }
    });
    await t.test('cancelled and absence rows do not occupy capacity; pending overrides do not replace effective capacity', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_assignments (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence) VALUES
        (1,1,CURRENT_DATE,1,1,1,1,'APPROVED',2),(2,1,CURRENT_DATE,1,1,1,1,'REQUESTED',2),
        (3,1,CURRENT_DATE,1,1,1,1,'CANCELLED',2),(4,1,CURRENT_DATE,1,1,1,1,'APPROVED',1),
        (5,1,CURRENT_DATE,1,1,1,2,'DRAFT',2);
        INSERT INTO shiftly_schema.shift_assignment_capacity_groups VALUES (1,1,CURRENT_DATE,1,1,1,1,10,12,'REQUESTED');`);
      const day = await current();
      assert.equal(day.day_assigned, 2); assert.equal(day.day_required, 10);
      assert.equal(day.night_assigned, 1); assert.equal(day.night_missing, false);
      assert.equal((await overview()).total_assignments, 3);
    });
    await t.test('period-used night shift takes precedence over unused midnight alternatives', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_types (id,start_time,end_time,day_type,is_active) VALUES (3,'00:00','08:00','WEEKDAY_ONLY',true);
        INSERT INTO shiftly_schema.staff_shift_rules VALUES (3,1,1,1,3,1,true);`);
      const data = await overview();
      for (const day of data.days) {
        const weekday = new Date(day.date + 'T12:00:00Z').getUTCDay();
        assert.equal(day.night_required, 4);
        assert.equal(day.night_missing, day.date !== today);
      }
    });
    await t.test('alternative day/night types do not inflate saved capacity or invent missing shifts', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_types (id,start_time,end_time,day_type,is_active) VALUES
        (4,'08:00','16:00','ANY',true),(5,'22:00','06:00','ANY',true);
        INSERT INTO shiftly_schema.staff_shift_rules VALUES
        (4,1,1,1,4,6,true),(5,1,1,1,5,3,true);`);
      const data = await overview();
      const saved = data.days.find(d => d.date === today);
      assert.equal(saved.day_required, 10);
      assert.equal(saved.night_required, 4);
      const absent = data.days.find(d => d.date !== today);
      assert.equal(absent.day_required, 8);
      assert.equal(absent.night_required, 4);
      assert.equal(absent.night_missing, true);
      assert.deepEqual(absent.shifts.map(s => s.shift_type_id), [1,2]);
    });
    await t.test('a partially created category does not add uncreated staff groups or alternative types', async () => {
      await db.query(`INSERT INTO shiftly_schema.staff_types VALUES (2,'RN',true);
        INSERT INTO shiftly_schema.staff_shift_rules VALUES (6,1,1,2,1,5,true);
        INSERT INTO shiftly_schema.shift_assignment_capacity_groups VALUES
        (2,1,CURRENT_DATE-1,1,1,1,2,4,NULL,'APPROVED');`);
      assert.equal((await current()).day_required, 10);
      const yesterday = (await db.query("SELECT to_char(CURRENT_DATE-1,'YYYY-MM-DD') AS day")).rows[0].day;
      const explicitEmpty = (await overview()).days.find(d => d.date === yesterday);
      assert.equal(explicitEmpty.night_assigned, 0);
      assert.equal(explicitEmpty.night_required, 4);
      assert.equal(explicitEmpty.night_missing, true);
      assert.equal(explicitEmpty.day_required, 8);
    });
    await t.test('a day with only actual previous-night spillover still misses both period shifts', async () => {
      await db.query('SAVEPOINT spillover_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.shift_assignments
          (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,start_time,end_time)
          VALUES (16,1,CURRENT_DATE-3,1,1,1,2,'APPROVED',2,'19:00','07:30');`);
        const date = (await db.query("SELECT to_char(CURRENT_DATE-2,'YYYY-MM-DD') AS day")).rows[0].day;
        const day = (await overview()).days.find(d => d.date === date);
        assert.equal(day.day_assigned, 0); assert.equal(day.night_assigned, 0);
        assert.equal(day.shifts.find(s => s.shift_type_id === 1).missing, true);
        assert.equal(day.shifts.find(s => s.shift_type_id === 2).missing, true);
        assert.equal(day.spillover_count, 1); assert.equal(day.spillover_until, '07:30');
        assert.equal(day.spillover_only, true);
        await db.query(`INSERT INTO shiftly_schema.shift_periods VALUES
          (2,CURRENT_DATE-2,CURRENT_DATE-2,1,1),
          (3,CURRENT_DATE-10,CURRENT_DATE-3,1,1),
          (4,CURRENT_DATE-10,CURRENT_DATE-3,2,1);
          INSERT INTO shiftly_schema.shift_assignments
          (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,start_time,end_time)
          VALUES (19,3,CURRENT_DATE-3,1,1,1,2,'APPROVED',2,'19:00','06:00'),
                 (20,4,CURRENT_DATE-3,2,1,1,2,'APPROVED',2,'19:00','09:00');`);
        const crossPeriod = (await overview()).days.find(d => d.date === date);
        assert.equal(crossPeriod.spillover_count, 2);
        assert.equal(crossPeriod.spillover_until, '07:30');
        assert.equal(crossPeriod.spillover_only, true);
        await db.query(`
          INSERT INTO shiftly_schema.shift_assignments
          (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,start_time,end_time)
          VALUES (18,2,CURRENT_DATE-2,1,1,1,1,'APPROVED',2,'08:00','16:00');`);
        assert.equal((await overview()).days.find(d => d.date === date).spillover_only, false);
      } finally { await db.query('ROLLBACK TO SAVEPOINT spillover_case'); }
    });
    await t.test('morning, afternoon and custom shifts preserve their own labels and exact-midnight is not spillover', async () => {
      await db.query('SAVEPOINT named_shifts_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.shift_types
          (id,start_time,end_time,day_type,is_active,shift_label,shift_code) VALUES
          (10,'07:00','15:00','ANY',true,'Morning 8h','M8'),
          (11,'16:00','00:00','ANY',true,'Afternoon 8h','A8'),
          (12,'09:00','12:00','ANY',true,'Clinic cover','CC'),
          (13,'12:00','16:00','ANY',true,'Procedure team','PT');
          INSERT INTO shiftly_schema.staff_shift_rules VALUES
          (10,1,1,1,10,2,true),(11,1,1,1,11,3,true),(12,1,1,1,12,1,true),(13,1,1,1,13,2,true);
          INSERT INTO shiftly_schema.shift_assignment_capacity_groups VALUES
          (10,1,CURRENT_DATE-4,1,1,1,10,2,NULL,'APPROVED'),
          (11,1,CURRENT_DATE-4,1,1,1,11,3,NULL,'APPROVED'),
          (12,1,CURRENT_DATE-4,1,1,1,12,1,NULL,'APPROVED'),
          (13,1,CURRENT_DATE-4,1,1,1,13,2,NULL,'APPROVED');
          INSERT INTO shiftly_schema.shift_assignments
          (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,start_time,end_time)
          VALUES (17,1,CURRENT_DATE-4,1,1,1,11,'APPROVED',2,'16:00','00:00');`);
        const date = (await db.query("SELECT to_char(CURRENT_DATE-3,'YYYY-MM-DD') AS day")).rows[0].day;
        const day = (await overview()).days.find(d => d.date === date);
        assert.equal(day.shifts.find(s => s.shift_type_id === 10).category, 'morning');
        assert.equal(day.shifts.find(s => s.shift_type_id === 11).category, 'afternoon');
        assert.equal(day.shifts.find(s => s.shift_type_id === 11).label, 'Afternoon 8h');
        assert.ok(day.shifts.some(s => s.label === 'Clinic cover'));
        assert.ok(day.shifts.some(s => s.label === 'Procedure team'));
        assert.equal(day.spillover_count, 0);
      } finally { await db.query('ROLLBACK TO SAVEPOINT named_shifts_case'); }
    });
    await t.test('multiple period-used alternatives expose known absence without invented capacity totals', async () => {
      await db.query('SAVEPOINT alternatives_case');
      try {
        await db.query(`UPDATE shiftly_schema.shift_types SET shift_label='Day 8h' WHERE id=4;
          INSERT INTO shiftly_schema.shift_assignment_capacity_groups VALUES
          (20,1,CURRENT_DATE-5,1,1,1,4,6,NULL,'APPROVED');`);
        const date = (await db.query("SELECT to_char(CURRENT_DATE-3,'YYYY-MM-DD') AS day")).rows[0].day;
        const day = (await overview()).days.find(d => d.date === date);
        const emptyDay = day.shifts.find(s => s.category === 'day');
        assert.equal(emptyDay.shift_type_id, null); assert.equal(emptyDay.assigned, 0);
        assert.equal(emptyDay.required, null); assert.equal(emptyDay.missing, true);
        assert.equal(day.day_required, null);
      } finally { await db.query('ROLLBACK TO SAVEPOINT alternatives_case'); }
    });
    await t.test('zero required capacity does not create a missing-shift warning', async () => {
      await db.query('SAVEPOINT zero_capacity_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.shift_assignment_capacity_groups VALUES
          (30,1,CURRENT_DATE-6,1,1,1,1,0,NULL,'APPROVED'),
          (31,1,CURRENT_DATE-6,1,1,1,2,0,NULL,'APPROVED');`);
        const date = (await db.query("SELECT to_char(CURRENT_DATE-6,'YYYY-MM-DD') AS day")).rows[0].day;
        const day = (await overview()).days.find(d => d.date === date);
        assert.equal(day.day_required, 0); assert.equal(day.night_required, 0);
        assert.ok(day.shifts.every(s => s.assigned === 0 && s.required === 0 && !s.missing));
      } finally { await db.query('ROLLBACK TO SAVEPOINT zero_capacity_case'); }
    });
    await t.test('missing history and future census stay unknown; recorded stable census has no alert', async () => {
      assert.equal((await current()).patient_count, null);
      await db.query(`INSERT INTO shiftly_schema.clinical_encounters
        SELECT n,1,1,'ACTIVE',CURRENT_DATE-20,NULL FROM generate_series(1,10) n;
        INSERT INTO shiftly_schema.clinical_encounter_locations
        SELECT n,n,1,1,CURRENT_DATE-20,NULL FROM generate_series(1,10) n;`);
      const day = await current();
      assert.equal(day.patient_count, 10); assert.equal(day.patient_baseline, 10);
      assert.equal(day.patient_alert, false);
      assert.equal((await overview()).days.at(-1).patient_count, null);
    });
    await t.test('sudden increases and decreases alert, without changing capacity', async () => {
      await db.query(`INSERT INTO shiftly_schema.clinical_encounters SELECT n,1,1,'ACTIVE',CURRENT_DATE,NULL FROM generate_series(11,16) n;
        INSERT INTO shiftly_schema.clinical_encounter_locations SELECT n,n,1,1,CURRENT_DATE,NULL FROM generate_series(11,16) n;`);
      let day = await current();
      assert.equal(day.patient_delta, 6); assert.equal(day.patient_alert, true);
      assert.equal(day.day_required, 10);
      await db.query(`DELETE FROM shiftly_schema.clinical_encounter_locations WHERE id>10;
        DELETE FROM shiftly_schema.clinical_encounters WHERE id>10;
        UPDATE shiftly_schema.clinical_encounters SET discharged_at=CURRENT_DATE WHERE id<=4;
        UPDATE shiftly_schema.clinical_encounter_locations SET ended_at=CURRENT_DATE WHERE id<=4;`);
      day = await current();
      assert.equal(day.patient_delta, -4); assert.equal(day.patient_alert, true);
    });
    await t.test('old discharges and future admissions are outside the observed census window', async () => {
      await db.query(`INSERT INTO shiftly_schema.clinical_encounters VALUES
        (100,1,1,'DISCHARGED',CURRENT_DATE-100,CURRENT_DATE-50),
        (101,1,1,'ACTIVE',CURRENT_DATE+20,NULL);
        INSERT INTO shiftly_schema.clinical_encounter_locations VALUES
        (100,100,1,1,CURRENT_DATE-100,CURRENT_DATE-50),
        (101,101,1,1,CURRENT_DATE+20,NULL);`);
      const day = await current();
      assert.equal(day.patient_count, 6);
      assert.equal(day.patient_baseline, 10);
      assert.equal(day.patient_delta, -4);
    });
    await t.test('patient matrix contains fixed historical snapshots, real last-shift cutoff, and independent live now', async () => {
      await db.query('SAVEPOINT matrix_case');
      try {
        await db.query(`INSERT INTO shiftly_schema.clinical_encounters VALUES
          (201,1,1,'ACTIVE',CURRENT_DATE-2+time '10:00',NULL);
          INSERT INTO shiftly_schema.clinical_encounter_locations VALUES
          (201,201,1,1,CURRENT_DATE-2+time '10:00',NULL);
          INSERT INTO shiftly_schema.shift_assignments
          (id,shift_period_id,shift_date,division_id,department_id,staff_type_id,shift_type_id,status,is_absence,start_time,end_time)
          VALUES (201,1,CURRENT_DATE-3,1,1,1,2,'APPROVED',2,'19:00','07:30');`);
        const date = (await db.query("SELECT to_char(CURRENT_DATE-2,'YYYY-MM-DD') AS day")).rows[0].day;
        const data = await overview();
        const day = data.days.find(d => d.date === date);
        const rows = day.patient_comparisons;
        assert.deepEqual(rows.map(r => r.key), ['days_3','days_2','day_1','last_shift','selected_day','live_now']);
        assert.deepEqual(rows.map(r => r.count), [10,10,10,10,11,7]);
        assert.equal(rows[3].observed_at, date+'T07:30:00');
        assert.equal(rows[3].shift_label, 'Night 12h');
        assert.equal(rows[4].observed_at, date+'T23:59:59');
        assert.ok(rows[5].observed_at.startsWith(today+'T'));
        const futureRows = data.days.at(-1).patient_comparisons;
        assert.equal(futureRows.find(r => r.key === 'selected_day').count, null);
        assert.equal(futureRows.find(r => r.key === 'last_shift').count, null);
        assert.equal(futureRows.find(r => r.key === 'live_now').count, 7);
        assert.ok((await current(2)).patient_comparisons.every(r => r.count === null));
      } finally { await db.query('ROLLBACK TO SAVEPOINT matrix_case'); }
    });
    await t.test('no patient permission, incomplete locations and unauthorized periods do not expose fabricated census', async () => {
      const hidden = await current(2);
      assert.equal(hidden.patient_count, null); assert.equal(hidden.patient_alert, false);
      assert.equal(await overview(3), undefined);
      await db.query('DELETE FROM shiftly_schema.clinical_encounter_locations WHERE id=10');
      const incomplete = await current();
      assert.equal(incomplete.patient_count, null); assert.equal(incomplete.patient_alert, false);
    });
    await t.test('old recorded locations still establish known zero after all patients have left', async () => {
      await db.query(`UPDATE shiftly_schema.clinical_encounters SET discharged_at=CURRENT_DATE-30, admitted_at=CURRENT_DATE-100 WHERE id<=10;
        UPDATE shiftly_schema.clinical_encounter_locations SET started_at=CURRENT_DATE-100, ended_at=CURRENT_DATE-30 WHERE encounter_id<=10;`);
      const day = await current();
      assert.equal(day.patient_count, 0);
      assert.equal(day.patient_baseline, 0);
      assert.equal(day.patient_alert, false);
    });
  } finally {
    await db.end().catch(() => {});
    if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    // Only remove this test's newly created directory, never an application path.
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('shift-period-overview-')) fs.rmSync(temp, { recursive: true, force: true });
  }
});


