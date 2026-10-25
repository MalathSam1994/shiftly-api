const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const registry = require('../reports/clinicalHandover/registry');
const { excel } = require('../reports/clinicalHandover/excel');

const REPORT = 'available_beds_by_unit';
const ACTOR = 271;
const REFERENCE = '2026-10-24T10:00:00.000Z';
const PAIR = { division_id: 1, department_id: 2, division_name: 'Hospital', department_name: 'Medicine' };
const UNIT_LOOKUP = '-- available_beds_by_unit: active unit lookup';
const UNIT_CHOICE = { value: 1, label: 'Ward 1 | Medicine | Hospital',
  meta: { unitId: 1, divisionId: 1, departmentId: 2, divisionIdLabel: 'Hospital', departmentIdLabel: 'Medicine' } };

function sourceData(count = 1) {
  const units = Array.from({ length: count }, (_, index) => ({
    unitId: index + 1, division: 'Hospital', department: 'Medicine', unit: `Ward ${index + 1}`,
    totalBeds: 10, occupiedBeds: 3, availableBeds: 7, availableBedsUpperBound: 7,
    availabilityKind: 'CONFIRMED', availabilityStatus: 'Available', activePatients: 3, unknownBeds: 0,
  }));
  return {
    context: { version: 2, reference: REFERENCE, basis: 'CURRENT' },
    totals: { units: count, totalBeds: count * 10, occupiedBeds: count * 3, availableBeds: count * 7,
      availableBedsUpperBound: count * 7, availabilityKind: 'CONFIRMED', estimatedUnits: 0, missingCapacityUnits: 0,
      unavailableUnits: 0, knownUnits: count, activePatients: count * 3, unknownBeds: 0 },
    units, notes: [],
  };
}

// The actual registry, reader and service run against a controlled database
// boundary. SQL arithmetic and organization filtering have separate SQL tests.
function harness(count = 1) {
  const state = {
    source: sourceData(count), unitChoices: [structuredClone(UNIT_CHOICE)],
    calls: [], saved: new Map(), released: 0, scopeAllowed: true,
    denied: new Set([registry.EXPORT, registry.STAFF, registry.REVIEW]),
  };
  const pool = { async connect() {
    let mode;
    return {
      release() { state.released++; },
      async query(sql, args = []) {
        if (/^BEGIN/.test(sql)) mode = sql.includes('READ ONLY') ? 'read' : 'write';
        state.calls.push({ sql, args: structuredClone(args), mode });
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql) || sql.includes('set_config(') ||
            sql.includes('pg_advisory_xact_lock') || /^DELETE FROM/.test(sql)) return { rows: [] };
        if (sql.includes('FROM unnest($2::text[])')) {
          return { rows: args[1].map(k => ({ k, allowed: !state.denied.has(k) })) };
        }
        if (sql.includes(UNIT_LOOKUP)) {
          const choices = state.unitChoices.filter(choice => args[4] == null || String(choice.value) === args[4]);
          return { rows: [{ value: { rows: structuredClone(choices.slice(args[3], args[3] + 50)),
            total: choices.length, offset: args[3], limit: 50, business_timezone: 'Europe/Berlin' } }] };
        }
        if (sql.includes('fn_handover_report_scope(')) {
          const parameters = { ...args[1], ...(args[1].unitId ? { divisionId: 1, departmentId: 2 } : {}) };
          return { rows: [{ value: { parameters, pairs: [PAIR], unit_id: parameters.unitId,
            unit_name: parameters.unitId ? `Ward ${parameters.unitId}` : null,
            business_timezone: 'Europe/Berlin', business_today: '2026-10-24', reference_time: REFERENCE,
            interval_start: null, interval_end_exclusive: null } }] };
        }
        if (sql.includes('fn_handover_report_lookups(')) {
          const value = args[5] ? Number(args[5]) : 1;
          const label = args[1] === 'units' ? `Ward ${value}` : args[1] === 'departments' ? 'Medicine' : 'Hospital';
          return { rows: [{ value: { rows: [{ value, label, meta: {} }], more: false } }] };
        }
        if (sql.includes('fn_handover_available_beds_by_unit(')) {
          return { rows: [{ value: structuredClone(state.source) }] };
        }
        if (sql.includes('fn_user_can_access_division_department')) {
          assert.deepEqual(JSON.parse(args[1]), [PAIR]);
          return { rows: [{ ok: state.scopeAllowed }] };
        }
        if (/^INSERT INTO shiftly_schema.clinical_handover_report_generations/.test(sql)) {
          const [id, actor_id, report_id, authorized_scope, dataset] = structuredClone(args);
          const record = { id, actor_id, report_id, authorized_scope, dataset,
            expires_at: '2026-10-24T10:30:00.000Z', expired: false };
          state.saved.set(id, record);
          return { rows: [{ expires_at: record.expires_at }] };
        }
        if (sql.includes('FROM shiftly_schema.clinical_handover_report_generations WHERE id=$1 AND actor_id=$2')) {
          const record = state.saved.get(args[0]);
          return { rows: record && record.actor_id === args[1] ? [structuredClone(record)] : [] };
        }
        throw new Error(`Unexpected report query: ${sql}`);
      },
    };
  } };
  const dbPath = require.resolve('../db');
  const servicePath = require.resolve('../reports/clinicalHandover/service');
  const previousDb = require.cache[dbPath], previousService = require.cache[servicePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  delete require.cache[servicePath];
  let service;
  try { service = require(servicePath); }
  finally {
    if (previousDb) require.cache[dbPath] = previousDb; else delete require.cache[dbPath];
    if (previousService) require.cache[servicePath] = previousService; else delete require.cache[servicePath];
  }
  return { service, state };
}

test('available-bed catalog is enabled with optional organization filters and only report/patient access', async () => {
  const { service, state } = harness();
  const catalog = await service.catalog(ACTOR);
  const definition = catalog.reports.find(report => report.id === REPORT);
  assert.equal(definition.available, true);
  assert.equal(definition.authorized, true);
  assert.equal(definition.timeBasis, 'CURRENT_SNAPSHOT');
  assert.deepEqual(definition.parameters, ['divisionId', 'departmentId', 'unitId']);
  assert.deepEqual(definition.required, []);
  assert.deepEqual(definition.access, [registry.OPEN, registry.PATIENT]);
  assert.deepEqual(definition.sections.map(section => section.id), ['units']);
  assert.equal(catalog.permissions[registry.EXPORT], false);
  state.denied.add(registry.PATIENT);
  assert.equal((await service.catalog(ACTOR)).reports.find(report => report.id === REPORT).authorized, false);
});

test('available-bed generation keeps a current snapshot and persists the complete scoped dataset', async () => {
  const { service, state } = harness();
  const generated = await service.generate(ACTOR, REPORT, { unitId: 1 });
  assert.equal(generated.referenceTime, REFERENCE);
  assert.equal(generated.generatedAt, REFERENCE);
  assert.equal(generated.timeBasis, 'CURRENT_SNAPSHOT');
  assert.equal(generated.bedAvailabilityContext.version, 2);
  assert.equal(generated.bedAvailabilityContext.basis, 'CURRENT');
  assert.equal(generated.intervalStart, null);
  assert.equal(generated.intervalEndExclusive, null);
  assert.match(generated.planningBasis, /current/i);
  assert.doesNotMatch(generated.planningBasis, /future|plan|discharge/i);
  assert.equal(generated.authorizedScope, undefined);
  assert.equal(generated.rowCount, 1);
  assert.deepEqual(generated.parameters, { ...registry.report(REPORT).defaults, unitId: 1, divisionId: 1, departmentId: 2 });
  assert.deepEqual(generated.selections.unitId, UNIT_CHOICE);
  assert.equal(generated.scopeLabel, UNIT_CHOICE.label);
  const unitLookup = state.calls.find(call => call.sql.includes(UNIT_LOOKUP));
  assert.deepEqual(unitLookup.args, [ACTOR, generated.parameters, '', 0, '1']);
  assert.equal(state.calls.some(call => call.sql.includes('fn_handover_report_lookups(') && call.args[1] === 'units'), false);
  const readCall = state.calls.find(call => call.sql.includes('fn_handover_available_beds_by_unit('));
  assert.deepEqual(readCall.args, [ACTOR, generated.parameters]);
  assert.equal(readCall.mode, 'read');
  const stored = state.saved.get(generated.generationId);
  assert.deepEqual(stored.authorized_scope.pairs, [PAIR]);
  assert.deepEqual(stored.dataset.sections, generated.sections);
  assert.equal(state.calls.find(call => call.sql.startsWith('INSERT INTO')).mode, 'write');
  assert.equal(state.released, 2);
});

test('organization filters reach the scoped reader and lookup without requiring a unit', async () => {
  const { service, state } = harness();
  for (const filter of [{}, { divisionId: 1 }, { divisionId: 1, departmentId: 2 }]) {
    const generated = await service.generate(ACTOR, REPORT, filter);
    assert.deepEqual(generated.parameters, { ...registry.report(REPORT).defaults, ...filter });
    assert.deepEqual(state.calls.filter(call => call.sql.includes('fn_handover_available_beds_by_unit(')).at(-1).args,
      [ACTOR, generated.parameters]);
  }
  const choices = await service.lookups(ACTOR, REPORT, 'unitId', { divisionId: 1, departmentId: 2 }, 'Ward', 0);
  assert.deepEqual(choices.rows, [UNIT_CHOICE]);
  assert.equal(choices.total, 1);
  const lookup = state.calls.filter(call => call.sql.includes(UNIT_LOOKUP)).at(-1);
  assert.deepEqual(lookup.args, [ACTOR,
    { ...registry.report(REPORT).defaults, divisionId: 1, departmentId: 2 }, 'Ward', 0, null]);
  await service.lookups(ACTOR, REPORT, 'unitId', {}, 'Ward', 50);
  assert.deepEqual(state.calls.filter(call => call.sql.includes(UNIT_LOOKUP)).at(-1).args,
    [ACTOR, registry.report(REPORT).defaults, 'Ward', 50, null]);
});

test('an inactive or removed unit is rejected when exact active selection no longer resolves', async () => {
  const { service, state } = harness();
  state.unitChoices = [];
  await assert.rejects(service.generate(ACTOR, REPORT, { unitId: 1 }),
    { status: 409, code: 'REPORT_SELECTION_CHANGED' });
  assert.equal(state.calls.filter(call => call.sql.includes(UNIT_LOOKUP)).length, 1);
  assert.equal(state.calls.some(call => call.sql.includes('fn_handover_available_beds_by_unit(')), false);
  assert.equal(state.saved.size, 0);
});

test('bed report rejects dates and historical selectors before accessing the database', async () => {
  const { service, state } = harness();
  for (const key of ['shiftDate', 'fromDate', 'toDate', 'fromTime', 'toTime', 'referenceTime', 'shiftContextId']) {
    await assert.rejects(service.generate(ACTOR, REPORT, { [key]: '2026-10-25' }),
      { status: 400, code: 'REPORT_VALIDATION' });
  }
  await assert.rejects(service.generate(ACTOR, REPORT, { departmentId: 2 }), /Choose the division/);
  assert.equal(state.calls.length, 0);
});

test('report and patient permissions protect generation and lookups; export is checked separately', async () => {
  for (const deniedPermission of [registry.OPEN, registry.PATIENT]) {
    const { service, state } = harness();
    state.denied.add(deniedPermission);
    await assert.rejects(service.generate(ACTOR, REPORT, {}), { status: 403, code: 'REPORT_FORBIDDEN' });
    await assert.rejects(service.lookups(ACTOR, REPORT, 'unitId', {}, '', 0), { status: 403, code: 'REPORT_FORBIDDEN' });
    assert.equal(state.saved.size, 0);
    assert.equal(state.calls.some(call => /fn_handover_(available_beds_by_unit|report_lookups)\(/.test(call.sql)), false);
    assert.equal(state.calls.some(call => call.sql.includes(UNIT_LOOKUP)), false);
  }
  const { service, state } = harness();
  const generated = await service.generate(ACTOR, REPORT, {});
  assert.equal((await service.retrieve(ACTOR, generated.generationId)).reportId, REPORT);
  await assert.rejects(service.retrieve(ACTOR, generated.generationId, true), { status: 403, code: 'REPORT_FORBIDDEN' });
  state.denied.delete(registry.EXPORT);
  assert.equal((await service.retrieve(ACTOR, generated.generationId, true)).reportId, REPORT);
  state.denied.add(registry.PATIENT);
  await assert.rejects(service.retrieve(ACTOR, generated.generationId), { status: 403, code: 'REPORT_FORBIDDEN' });
});

test('saved availability remains immutable and requires its original actor and current scope', async () => {
  const { service, state } = harness();
  const generated = await service.generate(ACTOR, REPORT, {});
  state.source.units[0].availableBeds = 0;
  generated.sections[0].rows[0].availableBeds = 99;
  const saved = await service.retrieve(ACTOR, generated.generationId);
  assert.equal(saved.sections[0].rows[0].availableBeds, 7);
  assert.equal(state.calls.filter(call => call.sql.includes('fn_handover_available_beds_by_unit(')).length, 1);
  await assert.rejects(service.retrieve(ACTOR + 1, generated.generationId), { status: 410, code: 'REPORT_EXPIRED' });
  state.scopeAllowed = false;
  await assert.rejects(service.retrieve(ACTOR, generated.generationId), { status: 403, code: 'REPORT_SCOPE_CHANGED' });
  state.scopeAllowed = true;
  state.saved.get(generated.generationId).expired = true;
  await assert.rejects(service.retrieve(ACTOR, generated.generationId), { status: 410, code: 'REPORT_EXPIRED' });
});

test('preview pages do not truncate a complete saved available-bed Excel export', async () => {
  const { service, state } = harness(105);
  Object.assign(state.source.units[0], { occupiedBeds: 10, availableBeds: 0, availableBedsUpperBound: 0,
    activePatients: 10, availabilityStatus: 'At capacity' });
  Object.assign(state.source.units[1], { totalBeds: 20, occupiedBeds: 5, availableBeds: null, availableBedsUpperBound: 15,
    activePatients: 7, unknownBeds: 2, availabilityKind: 'UPPER_BOUND', availabilityStatus: 'Needs verification' });
  Object.assign(state.source.units[2], { totalBeds: null, availableBeds: null, availableBedsUpperBound: null,
    availabilityKind: 'CAPACITY_NOT_CONFIGURED', availabilityStatus: 'Capacity not configured' });
  Object.assign(state.source.totals, { totalBeds: null, occupiedBeds: 324, availableBeds: null, availableBedsUpperBound: null,
    availabilityKind: 'CAPACITY_NOT_CONFIGURED', activePatients: 326, unknownBeds: 2, knownUnits: 103,
    unavailableUnits: 2, estimatedUnits: 1, missingCapacityUnits: 1 });
  state.source.units[104].unit = '=Ward 105';
  const generated = await service.generate(ACTOR, REPORT, {});
  assert.equal(generated.sections[0].rows.length, 100);
  assert.equal(generated.page.total, 105);
  assert.equal(generated.rowCount, 105);
  state.denied.delete(registry.EXPORT);
  const saved = await service.retrieve(ACTOR, generated.generationId, true);
  const secondPage = service.preview(saved, 'units', 100, 100);
  assert.equal(secondPage.sections[0].rows.length, 5);
  assert.equal(secondPage.sections[0].rows[4].unit, '=Ward 105');
  assert.equal(secondPage.authorizedScope, undefined);
  const exported = service.exportData(saved);
  assert.equal(exported.authorizedScope, undefined);
  assert.equal(exported.sections[0].rows.length, 105);
  assert.throws(() => service.exportData(generated), { status: 500, code: 'REPORT_CONTRACT' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await excel(exported));
  const units = workbook.getWorksheet('Available beds by unit');
  assert.ok(units, 'The report has a clearly named Available beds by unit worksheet');
  assert.equal(units.rowCount, 106);
  const unitColumn = exported.sections[0].columns.findIndex(column => column.key === 'unit') + 1;
  const availableColumn = exported.sections[0].columns.findIndex(column => column.key === 'availableBeds') + 1;
  const unknownColumn = exported.sections[0].columns.findIndex(column => column.key === 'unknownBeds') + 1;
  assert.equal(units.columnCount, 8);
  assert.equal(unknownColumn, 6);
  assert.equal(units.getCell(1, unknownColumn).value, 'Patients without a recorded bed');
  assert.equal(units.getCell(2, unknownColumn).value, 0);
  assert.equal(units.getCell(3, unknownColumn).value, 2);
  assert.equal(units.getCell(3, unknownColumn).type, ExcelJS.ValueType.Number);
  const zeroAvailable = units.getCell(2, availableColumn), estimatedAvailable = units.getCell(3, availableColumn);
  const missingCapacity = units.getCell(4, availableColumn), exactAvailable = units.getCell(5, availableColumn);
  assert.equal(zeroAvailable.value, 0);
  assert.equal(zeroAvailable.type, ExcelJS.ValueType.Number);
  assert.equal(exactAvailable.value, 7);
  assert.equal(exactAvailable.type, ExcelJS.ValueType.Number);
  assert.equal(estimatedAvailable.value, 'Up to 15 — needs verification');
  assert.equal(estimatedAvailable.type, ExcelJS.ValueType.String);
  assert.equal(estimatedAvailable.font.color.argb, 'FFC2410C');
  assert.equal(missingCapacity.value, 'Capacity not configured');
  assert.equal(missingCapacity.type, ExcelJS.ValueType.String);
  assert.equal(missingCapacity.fill.fgColor.argb, 'FFF3F4F6');
  assert.equal(zeroAvailable.fill.fgColor.argb, 'FFEAF6F1');
  assert.equal(zeroAvailable.font.bold, true);
  assert.equal(estimatedAvailable.font.bold, true);
  assert.equal(units.views[0].state, 'frozen');
  assert.equal(units.views[0].xSplit, 3);
  assert.equal(units.views[0].ySplit, 1);
  assert.equal(units.autoFilter, 'A1:H106');
  assert.equal(units.getCell(106, unitColumn).value, '=Ward 105');
  assert.equal(units.getCell(106, unitColumn).type, ExcelJS.ValueType.String);
  const summaryRows = workbook.getWorksheet('Overview').getRows(1, workbook.getWorksheet('Overview').rowCount);
  const availableSummary = summaryRows.filter(row => row.getCell(1).value === 'Available beds');
  assert.equal(availableSummary.length, 1);
  assert.equal(availableSummary[0].getCell(2).value, 'Capacity not configured');
});

test('Excel Overview qualifies upper bounds including zero and preserves confirmed numeric zero', async () => {
  for (const example of [
    { totalBeds: 20, occupiedBeds: 5, unknownBeds: 2, activePatients: 7,
      availableBeds: null, availableBedsUpperBound: 15, availabilityKind: 'UPPER_BOUND', display: 'Up to 15 — needs verification' },
    { totalBeds: 0, occupiedBeds: 0, unknownBeds: 2, activePatients: 2,
      availableBeds: null, availableBedsUpperBound: 0, availabilityKind: 'UPPER_BOUND', display: 'Up to 0 — needs verification' },
    { totalBeds: 0, occupiedBeds: 0, unknownBeds: 0, activePatients: 0,
      availableBeds: 0, availableBedsUpperBound: 0, availabilityKind: 'CONFIRMED', display: 0 },
  ]) {
    const { service, state } = harness();
    const { display, ...fields } = example;
    Object.assign(state.source.units[0], fields);
    const uncertain = fields.availabilityKind === 'UPPER_BOUND';
    Object.assign(state.source.totals, fields, { knownUnits: uncertain ? 0 : 1,
      unavailableUnits: uncertain ? 1 : 0, estimatedUnits: uncertain ? 1 : 0, missingCapacityUnits: 0 });
    const generated = await service.generate(ACTOR, REPORT, {});
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await excel(service.exportData(await service.retrieve(ACTOR, generated.generationId))));
    const summary = workbook.getWorksheet('Overview');
    const availabilityRows = summary.getRows(1, summary.rowCount).filter(row => /Available beds/.test(String(row.getCell(1).value)));
    assert.equal(availabilityRows.length, 1);
    assert.equal(availabilityRows[0].getCell(1).value, 'Available beds');
    const totalCell = availabilityRows[0].getCell(2);
    const unitCell = workbook.getWorksheet('Available beds by unit').getCell('G2');
    for (const cell of [totalCell, unitCell]) {
      assert.equal(cell.value, display);
      assert.equal(cell.type, uncertain ? ExcelJS.ValueType.String : ExcelJS.ValueType.Number);
      if (uncertain) assert.equal(cell.font.color.argb, 'FFC2410C');
    }
  }
});

test('saved legacy unknown availability exports safely without inventing an upper bound or rewriting its snapshot', async () => {
  const { service, state } = harness(2);
  const generated = await service.generate(ACTOR, REPORT, {});
  const stored = state.saved.get(generated.generationId).dataset;
  stored.bedAvailabilityContext.version = 1;
  Object.assign(stored.sections[0].rows[0], { totalBeds: 20, occupiedBeds: 5, availableBeds: null, unknownBeds: 2, activePatients: 7 });
  Object.assign(stored.sections[0].rows[1], { totalBeds: 10, occupiedBeds: 10, availableBeds: 0, unknownBeds: 0, activePatients: 10 });
  Object.assign(stored.totals, { totalBeds: 30, occupiedBeds: 15, availableBeds: null, unknownBeds: 2, activePatients: 17, knownUnits: 1, unavailableUnits: 1 });
  for (const value of [stored.totals, ...stored.sections[0].rows]) {
    delete value.availabilityKind;
    delete value.availableBedsUpperBound;
    delete value.estimatedUnits;
    delete value.missingCapacityUnits;
  }
  stored.sections[0].columns = stored.sections[0].columns.filter(column => column.key !== 'unknownBeds');
  stored.summaries.find(summary => summary.label === 'Available beds').value = null;
  stored.summaries.find(summary => summary.label === 'Available beds').availability = 'UNAVAILABLE';
  const before = structuredClone(stored);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await excel(service.exportData(await service.retrieve(ACTOR, generated.generationId))));
  const units = workbook.getWorksheet('Available beds by unit');
  assert.equal(units.getCell('F2').value, 'Unavailable');
  assert.equal(units.getCell('F2').fill.fgColor.argb, 'FFF3F4F6');
  assert.equal(units.getCell('F3').value, 0);
  assert.equal(units.getCell('F3').type, ExcelJS.ValueType.Number);
  assert.equal(units.autoFilter, 'A1:G3');
  const summary = workbook.getWorksheet('Overview');
  assert.equal(summary.getRows(1, summary.rowCount).find(row => row.getCell(1).value === 'Available beds').getCell(2).value, 'Unavailable');
  assert.deepEqual(state.saved.get(generated.generationId).dataset, before);
});

test('a pre-refinement database report is rejected before persisting a misleading new generation', async () => {
  const { service, state } = harness();
  state.source.context.version = 1;
  await assert.rejects(service.generate(ACTOR, REPORT, {}), { status: 409, code: 'REPORT_UPDATE_REQUIRED' });
  assert.equal(state.saved.size, 0);
  assert.equal(state.calls.some(call => call.mode === 'write'), false);
});
