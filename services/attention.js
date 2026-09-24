const pool = require('../db');
const { runInTransactionWithBusinessTimezone } = require('../utils/shiftlyRuntimeConfig');

function actorUserId(req) {
  const id = Number(req.user?.sub ?? req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function attentionFilters(query = {}) {
  const result = {};
  for (const [name, values] of Object.entries({
    domain: ['ALL', 'CLINICAL', 'SCHEDULING', 'OTHER'],
    status: ['ALL', 'ACTIVE', 'HISTORY', 'RESOLVED', 'EXPIRED', 'SUPERSEDED', 'UNAVAILABLE'],
    dateMode: ['TODAY', 'RANGE', 'ALL'],
    severity: ['CRITICAL', 'WARNING', 'INFO'],
    timeScope: ['LIVE', 'UPCOMING', 'SELECTED', 'HISTORICAL'],
    mode: ['BOARD', 'DASHBOARD', 'LIVE'],
    trigger: ['HANDOVER'],
  })) {
    if (query[name] == null || query[name] === '') continue;
    if (!values.includes(query[name])) throw new Error('Invalid filter');
    result[name] = query[name];
  }
  for (const name of ['unitId', 'shiftTypeId', 'staffTypeId', 'divisionId', 'departmentId',
    'locationDivisionId', 'locationDepartmentId', 'locationUnitId']) {
    if (query[name] == null || query[name] === '') continue;
    if (!/^[1-9]\d*$/.test(String(query[name])) || Number(query[name]) > 2147483647) throw new Error('Invalid identifier');
    result[name] = Number(query[name]);
  }
  // One location selection always carries the full organization pair.
  if ((result.locationDivisionId == null) !== (result.locationDepartmentId == null) ||
      (result.locationUnitId != null && result.locationDepartmentId == null)) {
    throw new Error('Choose a department/unit with its division');
  }
  for (const name of ['from', 'to', 'shiftDate']) {
    if (query[name] == null || query[name] === '') continue;
    const value = query[name];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
    const parsed = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
    result[name] = value;
  }
  if ((result.from == null) !== (result.to == null) ||
      (result.from != null && result.to <= result.from) ||
      (result.dateMode === 'RANGE' && result.from == null)) throw new Error('Invalid date range');
  if (query.liveOnly != null) {
    if (!['true', 'false'].includes(String(query.liveOnly))) throw new Error('Invalid live filter');
    result.liveOnly = String(query.liveOnly) === 'true';
  }
  if (query.search) {
    if (typeof query.search !== 'string' || query.search.length > 200) throw new Error('Invalid search');
    result.search = query.search.trim();
  }
  if (query.unreadOnly != null) {
    if (!['true', 'false'].includes(String(query.unreadOnly))) throw new Error('Invalid unread filter');
    result.unreadOnly = String(query.unreadOnly) === 'true';
  }
  result.limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  if (!Number.isInteger(result.limit)) throw new Error('Invalid page size');
  if (query.cursor) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 500) throw new Error('Invalid cursor');
    const cursor = JSON.parse(query.cursor);
    if (!cursor || !Number.isInteger(cursor.rank) || cursor.rank < 0 || cursor.rank > 14 ||
        !Number.isSafeInteger(cursor.id) || cursor.id <= 0 || typeof cursor.time !== 'string' ||
        !Number.isFinite(Date.parse(cursor.time))) throw new Error('Invalid cursor');
    result.cursor = cursor;
  }
  return result;
}

async function readAttention(userId, filters) {
  return runInTransactionWithBusinessTimezone(pool, async client => {
    const result = await client.query('SELECT shiftly_api.fn_attention_list($1::integer,$2::jsonb) AS result', [userId, filters]);
    return result.rows[0].result;
  });
}
async function readAttentionDetail(userId, id) {
  return runInTransactionWithBusinessTimezone(pool, async client => {
    const result = await client.query('SELECT shiftly_api.fn_attention_detail($1::integer,$2::bigint) AS result', [userId, id]);
    return result.rows[0].result;
  });
}
async function reconcileAttention() {
  return runInTransactionWithBusinessTimezone(pool, async client => {
    const result = await client.query('SELECT shiftly_api.fn_attention_reconcile(true) AS result');
    return result.rows[0].result;
  });
}
module.exports = { actorUserId, attentionFilters, readAttention, readAttentionDetail, reconcileAttention };
