const assert = require('node:assert/strict');
const test = require('node:test');

const {
  activeStatusSqlWithInclude,
  parseActiveStatusQuery,
  parseIncludeIds,
  parseOptionalBoolean,
} = require('../utils/activeStatus');

test('active_status defaults to active and rejects invalid values', () => {
  assert.equal(parseActiveStatusQuery({}), 'active');
  assert.equal(parseActiveStatusQuery({ active_status: 'inactive' }), 'inactive');
  assert.equal(parseActiveStatusQuery({ active_status: 'all' }), 'all');
  assert.throws(
    () => parseActiveStatusQuery({ active_status: 'enabled' }),
    /active_status must be active, inactive, or all/,
  );
});

test('legacy onlyActive is normalized without accepting arbitrary values', () => {
  assert.equal(parseActiveStatusQuery({ onlyActive: 'true' }), 'active');
  assert.equal(parseActiveStatusQuery({ onlyActive: 'false' }), 'all');
  assert.throws(() => parseActiveStatusQuery({ onlyActive: 'yes' }), /onlyActive/);
});

test('include_id and include_ids are parsed and de-duplicated', () => {
  assert.deepEqual(
    parseIncludeIds({ include_id: '4', include_ids: '4, 5,6' }),
    ['4', '5', '6'],
  );
});

test('active SQL supports current inactive row includes', () => {
  const sql = activeStatusSqlWithInclude({
    status: 'active',
    activeColumn: 'u.is_active',
    idColumn: 'u.id',
    startIndex: 3,
    includeIds: ['9'],
  });

  assert.equal(
    sql.clause,
    '(u.is_active = $3 OR u.id::text = ANY($4::text[]))',
  );
  assert.deepEqual(sql.params, [true, ['9']]);
  assert.equal(sql.nextIndex, 5);
});

test('Boolean parser preserves omitted values and rejects truthy strings', () => {
  assert.equal(parseOptionalBoolean(undefined), undefined);
  assert.equal(parseOptionalBoolean(false), false);
  assert.throws(() => parseOptionalBoolean('false'), /must be a Boolean/);
});
