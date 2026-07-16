const VALID_ACTIVE_STATUSES = new Set(['active', 'inactive', 'all']);

function normalizeLegacyOnlyActive(value) {
  if (value == null) return null;

  const raw = String(value).trim().toLowerCase();
  if (raw === 'true') return 'active';
  if (raw === 'false') return 'all';

  const err = new Error('onlyActive must be true or false.');
  err.statusCode = 400;
  throw err;
}

function parseActiveStatusQuery(query = {}) {
  const legacy = normalizeLegacyOnlyActive(query.onlyActive);
  const raw = query.active_status ?? query.activeStatus ?? legacy ?? 'active';
  const value = String(raw).trim().toLowerCase();

  if (!VALID_ACTIVE_STATUSES.has(value)) {
    const err = new Error('active_status must be active, inactive, or all.');
    err.statusCode = 400;
    throw err;
  }

  return value;
}

function activeStatusSql(status, column = 'is_active', startIndex = 1) {
  if (status === 'all') {
    return { clause: '', params: [], nextIndex: startIndex };
  }

  return {
    clause: `${column} = $${startIndex}`,
    params: [status === 'active'],
    nextIndex: startIndex + 1,
  };
}

function parseIncludeIds(query = {}) {
  const values = [];

  function append(raw) {
    if (raw == null || raw === '') return;
    if (Array.isArray(raw)) {
      raw.forEach(append);
      return;
    }
    String(raw)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => values.push(value));
  }

  append(query.include_id ?? query.includeId);
  append(query.include_ids ?? query.includeIds);

  return [...new Set(values)];
}

function activeStatusSqlWithInclude({
  status,
  activeColumn = 'is_active',
  idColumn,
  startIndex = 1,
  includeIds = [],
}) {
  if (status === 'all') {
    return { clause: '', params: [], nextIndex: startIndex };
  }

  if (!idColumn || includeIds.length === 0) {
    return activeStatusSql(status, activeColumn, startIndex);
  }

  return {
    clause: `(${activeColumn} = $${startIndex} OR ${idColumn}::text = ANY($${startIndex + 1}::text[]))`,
    params: [status === 'active', includeIds],
    nextIndex: startIndex + 2,
  };
}

function parseOptionalBoolean(value, fieldName = 'is_active') {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;

  const err = new Error(`${fieldName} must be a Boolean.`);
  err.statusCode = 400;
  throw err;
}

function parseCreateIsActive(body = {}) {
  const parsed = parseOptionalBoolean(body.is_active, 'is_active');
  return parsed ?? true;
}

function sendActiveStatusError(res, err) {
  if (err && err.statusCode === 400) {
    res.status(400).json({ error: err.message });
    return true;
  }

  return false;
}

module.exports = {
  activeStatusSql,
  activeStatusSqlWithInclude,
  parseIncludeIds,
  parseActiveStatusQuery,
  parseCreateIsActive,
  parseOptionalBoolean,
  sendActiveStatusError,
};
