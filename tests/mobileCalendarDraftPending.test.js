const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// This suite starts its own disposable cluster. Application DB settings are never read.
// RUN_MOBILE_CALENDAR_SQL_TESTS=1; optionally set PG_TEST_BIN to PostgreSQL's bin directory.
test('mobile calendar draft status uses pending presentation without changing workflow or schema', {
  skip: process.env.RUN_MOBILE_CALENDAR_SQL_TESTS !== '1', timeout: 180000,
}, async t => {
  const { Client } = require('pg');
  const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/17/bin';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-calendar-draft-'));
  const data = path.join(temp, 'data');
  const port = 55443;
  const command = (name, args) => {
    const result = spawnSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args,
      { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, `${name}: ${result.error || ''} ${result.stderr} ${result.stdout}`);
  };
  let started = false;
  const db = new Client({ host: '127.0.0.1', port, user: 'calendar_test', database: 'postgres' });
  try {
    command('initdb', ['-D', data, '-A', 'trust', '-U', 'calendar_test', '--encoding=UTF8', '--no-locale', '--no-sync']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true;
    await db.connect();
    await db.query(`
      SET TIME ZONE 'Europe/Berlin';
      CREATE SCHEMA shiftly_schema;
      CREATE SCHEMA shiftly_api;
      CREATE TABLE shiftly_schema.shift_periods
        (id int, start_date date, end_date date, division_id int, department_id int, status text);
      CREATE TABLE shiftly_schema.user_divisions (user_id int, division_id int);
      CREATE TABLE shiftly_schema.user_department (user_id int, department_id int);
      CREATE TABLE shiftly_schema.shift_assignments
        (id int, user_id int, shift_date date, status text, is_absence int, absence_type text);
      CREATE TABLE shiftly_schema.shift_requests
        (id int, requested_by_user_id int, requested_shift_date date, request_status text);
      CREATE TABLE shiftly_schema.user_absences
        (id int, user_id int, start_date date, end_date date, absence_type text);
      CREATE TABLE shiftly_schema.holiday_years (id int, year int);
      CREATE TABLE shiftly_schema.yearly_holidays (holiday_year_id int, holiday_date date, occasion text);
      CREATE TABLE calendar_test_options
        (user_id int, shift_date date, required_staff_count int, free_slots bigint, user_has_assigned_shift boolean);
      CREATE FUNCTION shiftly_api.fn_available_shift_options(p_user_id int, p_shift_date date)
      RETURNS TABLE(required_staff_count int, free_slots bigint, user_has_assigned_shift boolean)
      LANGUAGE sql STABLE AS $$
        SELECT o.required_staff_count, o.free_slots, o.user_has_assigned_shift
        FROM calendar_test_options o WHERE o.user_id=p_user_id AND o.shift_date=p_shift_date
      $$;
      INSERT INTO shiftly_schema.shift_periods VALUES (1,'2026-11-01','2026-11-30',1,1,'APPROVED');
      INSERT INTO shiftly_schema.user_divisions VALUES (1,1);
      INSERT INTO shiftly_schema.user_department VALUES (1,1);
      INSERT INTO shiftly_schema.holiday_years VALUES (1,2026);
    `);

    const baseline = fs.readFileSync(path.join(__dirname, '../../shiftly/DB/shiftly.sql'), 'utf8');
    for (const name of ['fn_shift_offer__is_absence_value', 'fn_mobile_calendar__is_blue_assignment', 'fn_mobile_calendar_day_states']) {
      const definition = baseline.match(new RegExp(`CREATE FUNCTION shiftly_api\\.${name}\\([\\s\\S]*?\\$\\$;`));
      assert.ok(definition, `Load the actual baseline definition of ${name}.`);
      await db.query(definition[0]);
    }
    const contract = async () => (await db.query(`SELECT pg_get_function_result(
      'shiftly_api.fn_mobile_calendar_day_states(integer,date,date)'::regprocedure) AS result`)).rows[0].result;
    const originalContract = await contract();
    await db.query(fs.readFileSync(path.join(__dirname,
      '../../shiftly/DB/migrations/20261103_mobile_calendar_draft_pending.sql'), 'utf8'));

    const reset = async (date = '2026-11-03') => {
      await db.query(`TRUNCATE shiftly_schema.shift_assignments, shiftly_schema.shift_requests,
        shiftly_schema.user_absences, shiftly_schema.yearly_holidays, calendar_test_options`);
      await db.query('INSERT INTO calendar_test_options VALUES (1,$1,2,1,false)', [date]);
    };
    const assignment = async (status, { date = '2026-11-03', id = 1, user = 1, absence = 2, absenceType = null } = {}) => {
      await db.query('INSERT INTO shiftly_schema.shift_assignments VALUES ($1,$2,$3,$4,$5,$6)',
        [id, user, date, status, absence, absenceType]);
    };
    const request = async (status = 'PENDING', id = 1) => {
      await db.query("INSERT INTO shiftly_schema.shift_requests VALUES ($1,1,'2026-11-03',$2)", [id, status]);
    };
    const day = async (date = '2026-11-03') => (await db.query(`SELECT * FROM
      shiftly_api.fn_mobile_calendar_day_states(1,'2026-11-01','2026-11-03') WHERE calendar_date=$1`, [date])).rows[0];

    await t.test('today draft is orange and opens details without fabricating a pending request', async () => {
      await reset();
      await assignment('DRAFT');
      const row = await day();
      assert.equal(row.dot_code, 'ORANGE');
      assert.equal(row.background_code, 'TODAY');
      assert.equal(row.is_today, true);
      assert.equal(row.is_past_date, false);
      assert.equal(row.is_clickable, true);
      assert.equal(row.tap_action, 'DETAILS');
      assert.equal(row.user_has_any_assignment, true);
      assert.equal(row.user_has_approved_assignment, false);
      assert.equal(row.has_pending_request, false);
      assert.equal(row.tooltip, 'Draft shift (pending approval)');
      assert.equal(row.reason_code, 'DRAFT_ASSIGNMENT_PENDING');
      assert.match(row.reason_detail, /(?:^|; )dot=ORANGE(?:;|$)/);
      assert.match(row.reason_detail, /(?:^|; )draftAssignment=true(?:;|$)/);
      const saved = (await db.query('SELECT status FROM shiftly_schema.shift_assignments')).rows;
      assert.deepEqual(saved, [{ status: 'DRAFT' }]);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM shiftly_schema.shift_requests')).rows[0].n, 0);
    });

    await t.test('draft normalization and lack of free capacity retain pending status', async () => {
      await reset();
      await assignment(' draft ');
      await db.query('UPDATE calendar_test_options SET free_slots=0');
      const row = await day();
      assert.equal(row.dot_code, 'ORANGE');
      assert.equal(row.reason_code, 'DRAFT_ASSIGNMENT_PENDING');
      assert.equal(row.avail_has_free_slot, false);
    });

    await t.test('other unapproved assignment statuses keep their existing black presentation', async () => {
      await reset();
      await assignment('UNAPPROVED');
      const row = await day();
      assert.equal(row.dot_code, 'BLACK');
      assert.equal(row.reason_code, 'NON_APPROVED_ASSIGNMENT');
      assert.equal(row.tap_action, 'DETAILS');
    });

    await t.test('approved work retains priority over a separate draft and pending request', async () => {
      await reset();
      await assignment('APPROVED');
      await assignment('DRAFT', { id: 2 });
      assert.equal((await day()).dot_code, 'GREEN_WHITE');
      await request();
      const row = await day();
      assert.equal(row.dot_code, 'GREEN_YELLOW');
      assert.equal(row.reason_code, 'APPROVED_SHIFT_PLUS_PENDING');
    });

    await t.test('absence and cancelled assignment presentation keep priority over a draft', async () => {
      await reset();
      await assignment('DRAFT');
      await assignment('CANCELLED', { id: 2 });
      assert.equal((await day()).dot_code, 'BLUE');
      await db.query('DELETE FROM shiftly_schema.shift_assignments WHERE id=2');
      await db.query("INSERT INTO shiftly_schema.user_absences VALUES (1,1,'2026-11-03','2026-11-03','SICK')");
      assert.equal((await day()).dot_code, 'BLUE_WHITE');
    });

    await t.test('request-only yellow and cancelled-plus-pending orange are unchanged', async () => {
      await reset();
      await request();
      const pending = await day();
      assert.equal(pending.dot_code, 'YELLOW');
      assert.equal(pending.reason_code, 'PENDING_ONLY');
      await request('CANCELLED', 2);
      const repeated = await day();
      assert.equal(repeated.dot_code, 'ORANGE');
      assert.equal(repeated.reason_code, 'CANCELLED_AND_PENDING');
    });

    await t.test('draft plus a real pending request stays orange with truthful request metadata', async () => {
      await reset();
      await assignment('DRAFT');
      await request();
      const row = await day();
      assert.equal(row.dot_code, 'ORANGE');
      assert.equal(row.reason_code, 'DRAFT_ASSIGNMENT_PENDING');
      assert.equal(row.tooltip, 'Draft shift (pending approval)');
      assert.equal(row.has_pending_request, true);
      assert.equal(row.tap_action, 'DETAILS');
    });

    await t.test('draft history uses pending color while date backgrounds remain independent', async () => {
      for (const [date, background, past, today] of [
        ['2026-11-02', 'PAST', true, false],
        ['2026-11-03', 'TODAY', false, true],
        ['2026-11-04', 'DEFAULT', false, false],
      ]) {
        await reset(date);
        await assignment('DRAFT', { date });
        const row = await day(date);
        assert.equal(row.dot_code, 'ORANGE', date);
        assert.equal(row.background_code, background, date);
        assert.equal(row.is_past_date, past, date);
        assert.equal(row.is_today, today, date);
      }
      await reset();
      await assignment('DRAFT');
      await db.query("INSERT INTO shiftly_schema.yearly_holidays VALUES (1,'2026-11-03','Test holiday')");
      assert.equal((await day()).background_code, 'PUBLIC_HOLIDAY');
      assert.equal((await day()).dot_code, 'ORANGE');
    });

    await t.test('another user draft does not change an available empty day', async () => {
      await reset();
      await assignment('DRAFT', { user: 2 });
      const row = await day();
      assert.equal(row.dot_code, 'WHITE_BORDER');
      assert.equal(row.reason_code, 'REQUESTABLE_EMPTY_DAY');
      assert.equal(row.user_has_any_assignment, false);
    });

    await t.test('replacement preserves all public return columns and types', async () => {
      assert.equal(await contract(), originalContract);
      assert.equal((await day()).user_has_draft_assignment, undefined);
    });
  } finally {
    await db.end().catch(() => {});
    if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    // The resolved target must remain this test's own freshly created temp directory.
    const resolvedTemp = path.resolve(temp);
    if (path.dirname(resolvedTemp) === path.resolve(os.tmpdir())
      && path.basename(resolvedTemp).startsWith('mobile-calendar-draft-')) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
});
