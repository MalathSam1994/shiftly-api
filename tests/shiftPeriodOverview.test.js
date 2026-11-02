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
const { shiftPeriodOverviewSql } = loadModule('query/shiftPeriodOverview.js', () => scope);

function routeHarness(rows = []) {
  const handlers = new Map();
  const calls = [];
  const router = { get: (url, fn) => handlers.set(url, fn), post() {}, put() {}, delete() {}, use() {} };
  loadModule('routes/shiftPeriods.js', name => {
    if (name === '../db') return { query: async (...args) => { calls.push(args); return { rows }; } };
    if (name === '../createCrudRouter') return () => router;
    if (name === '../utils/shiftPeriodScope') return scope;
    if (name === '../query/shiftPeriodOverview') return { shiftPeriodOverviewSql };
    if (name === '../utils/shiftlyRuntimeConfig') return { getBusinessTimezone: () => 'Europe/Berlin' };
    return {};
  });
  return { calls, run: async (id, user = { id: 1 }) => {
    const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get('/:id/overview')({ params: { id }, user }, res);
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
    const today = (await db.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS day")).rows[0].day;
    const overview = async (actor = 1) => (await db.query(shiftPeriodOverviewSql, [1, actor, 'UTC'])).rows[0]?.overview;
    const current = async (actor = 1) => (await overview(actor)).days.find(d => d.date === today);
    await t.test('zero-assigned rules create expected day and night capacity', async () => {
      const day = await current();
      assert.equal(day.day_assigned, 0); assert.equal(day.day_required, 8);
      assert.equal(day.night_assigned, 0); assert.equal(day.night_required, 4);
      assert.equal(day.night_missing, true);
    });
    await t.test('cancelled and absence rows do not occupy capacity; pending overrides do not replace effective capacity', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_assignments VALUES
        (1,1,CURRENT_DATE,1,1,1,1,'APPROVED',2),(2,1,CURRENT_DATE,1,1,1,1,'REQUESTED',2),
        (3,1,CURRENT_DATE,1,1,1,1,'CANCELLED',2),(4,1,CURRENT_DATE,1,1,1,1,'APPROVED',1),
        (5,1,CURRENT_DATE,1,1,1,2,'DRAFT',2);
        INSERT INTO shiftly_schema.shift_assignment_capacity_groups VALUES (1,1,CURRENT_DATE,1,1,1,1,10,12,'REQUESTED');`);
      const day = await current();
      assert.equal(day.day_assigned, 2); assert.equal(day.day_required, 10);
      assert.equal(day.night_assigned, 1); assert.equal(day.night_missing, false);
      assert.equal((await overview()).total_assignments, 3);
    });
    await t.test('midnight shifts are night and weekday-only alternatives stay unknown on eligible dates', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_types VALUES (3,'00:00','08:00','WEEKDAY_ONLY',true);
        INSERT INTO shiftly_schema.staff_shift_rules VALUES (3,1,1,1,3,1,true);`);
      const data = await overview();
      for (const day of data.days) {
        const weekday = new Date(day.date + 'T12:00:00Z').getUTCDay();
        assert.equal(day.night_required, day.date === today || weekday === 0 || weekday === 6 ? 4 : null);
        if (day.date !== today && weekday !== 0 && weekday !== 6) assert.equal(day.night_missing, false);
      }
    });
    await t.test('alternative day/night types do not inflate saved capacity or invent missing shifts', async () => {
      await db.query(`INSERT INTO shiftly_schema.shift_types VALUES
        (4,'08:00','16:00','ANY',true),(5,'22:00','06:00','ANY',true);
        INSERT INTO shiftly_schema.staff_shift_rules VALUES
        (4,1,1,1,4,6,true),(5,1,1,1,5,3,true);`);
      const data = await overview();
      const saved = data.days.find(d => d.date === today);
      assert.equal(saved.day_required, 10);
      assert.equal(saved.night_required, 4);
      const absent = data.days.find(d => d.date !== today);
      assert.equal(absent.day_required, null);
      assert.equal(absent.night_required, null);
      assert.equal(absent.night_missing, false);
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
      assert.equal(explicitEmpty.day_required, null);
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


