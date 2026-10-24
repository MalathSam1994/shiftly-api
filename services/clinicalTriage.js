// ESI is a separate triage observation. These helpers never change acuity,
// workload, assignment eligibility, or assignment freshness evidence.
const TRIAGE_ACTIONS = new Set(['RECORD', 'ESCALATE', 'CORRECT', 'CARE_STARTED']);
const MAX_ID = 2147483647;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'CLINICAL_TRIAGE_INVALID' });
}

function positiveId(value, name = 'encounterId', optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) > MAX_ID) {
    throw invalid(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function triageFilters(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw invalid('Triage filters must be an object.');
  const unit_id = positiveId(query.unitId, 'unitId', true);
  const level = positiveId(query.level, 'level', true);
  if (level != null && level > 5) throw invalid('ESI level must be between 1 and 5.');
  if (query.search != null && typeof query.search !== 'string') throw invalid('Search must be text.');
  const search = (query.search || '').trim();
  if (search.length > 160) throw invalid('Search must contain at most 160 characters.');
  let unrecorded = false;
  if (query.unrecorded != null && query.unrecorded !== '') {
    if (![true, false, 'true', 'false'].includes(query.unrecorded)) throw invalid('unrecorded must be true or false.');
    unrecorded = query.unrecorded === true || query.unrecorded === 'true';
  }
  if (level != null && unrecorded) throw invalid('Choose an ESI level or unrecorded, not both.');
  return { unit_id, level, search, unrecorded };
}

function triageRecordBody(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('A triage record is required.');
  if (typeof input.action !== 'string' || !TRIAGE_ACTIONS.has(input.action)) throw invalid('Choose a valid triage action.');
  if (!Number.isSafeInteger(input.expected_episode_id) || input.expected_episode_id < 1) {
    throw invalid('expected_episode_id must identify the current ED visit. Refresh the patient before saving.');
  }
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || input.expected_revision > MAX_ID) {
    throw invalid('expected_revision must be a non-negative integer. Refresh the patient before saving.');
  }
  if (input.level != null && input.esi_level != null && input.level !== input.esi_level) throw invalid('Conflicting ESI levels were supplied.');
  const level = input.level ?? input.esi_level ?? null;
  if (input.action === 'CARE_STARTED') {
    if (level != null) throw invalid('Care started does not assign a new ESI level.');
  } else if (!Number.isInteger(level) || level < 1 || level > 5) {
    throw invalid('ESI level must be an integer between 1 and 5.');
  }
  if (input.reason != null && typeof input.reason !== 'string') throw invalid('Reason must be text.');
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 1000) throw invalid('Reason must contain at most 1000 characters.');
  if (['ESCALATE', 'CORRECT'].includes(input.action) && !reason) throw invalid('A reason is required for escalation or correction.');
  // Only a trusted integration may assert external provenance. This endpoint
  // records the authenticated clinician and never accepts a supplied actor.
  if (input.source != null && input.source !== 'MANUAL') throw invalid('External triage sources are not supported by this recording endpoint.');
  let effective_at = null;
  if (input.effective_at != null) {
    if (typeof input.effective_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.effective_at)) {
      throw invalid('effective_at must be a complete timestamp with a timezone.');
    }
    const value = Date.parse(input.effective_at);
    const datePart = input.effective_at.slice(0, 10);
    const calendar = new Date(datePart + 'T00:00:00Z');
    if (!Number.isFinite(value) || Number(input.effective_at.slice(11, 13)) > 23 || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== datePart) {
      throw invalid('effective_at must be a valid timestamp.');
    }
    if (value > now) throw invalid('Triage observations cannot be dated in the future.');
    effective_at = new Date(value).toISOString();
  }
  return { action: input.action, expected_episode_id: input.expected_episode_id, expected_revision: input.expected_revision, level, reason, effective_at, source: 'MANUAL' };
}

function encounterIdOf(value) {
  const raw = value?.encounter_id ?? value?.encounterId;
  if (!['string', 'number'].includes(typeof raw) || !/^[1-9]\d*$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= MAX_ID ? id : null;
}

async function attachTriageSnapshots(db, actor, payload, { asOf = null } = {}) {
  const ids = new Set();
  function visit(value, map) {
    if (Array.isArray(value)) return value.map(item => visit(item, map));
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
    const id = encounterIdOf(value);
    if (id && !Object.hasOwn(value, 'triage')) ids.add(id);
    const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      // Existing history/report evidence and persisted triage must stay frozen.
      (['triage', 'history', 'entries', 'events', 'audit', 'run', 'latest_run', 'workflows', 'baseline'].includes(key) ||
        key.includes('snapshot') || key.endsWith('explanation') || key.endsWith('evidence')) ? item : visit(item, map)]));
    if (map && id && !Object.hasOwn(value, 'triage') && Object.hasOwn(map, String(id))) copy.triage = map[id];
    return copy;
  }
  visit(payload, null);
  if (!ids.size) return payload;
  const result = await db.query(
    'SELECT shiftly_api.fn_clinical_triage_snapshots($1::integer,$2::integer[],COALESCE($3::timestamptz,now())) AS snapshots',
    [actor, [...ids], asOf],
  );
  return visit(payload, result.rows[0]?.snapshots || {});
}

async function attachRunTriageSnapshots(db, actor, payload) {
  // Run assignments are historical proposal evidence. Read ESI as it was known
  // at generation, leaving saved optimizer snapshots and explanations intact.
  const reference = payload?.run?.generated_at;
  if (!reference || !Array.isArray(payload.assignments)) return payload;
  return { ...payload, assignments: await attachTriageSnapshots(db, actor, payload.assignments, { asOf: reference }) };
}

async function loadTriageDistribution(db, actor, filters = {}) {
  const result = await db.query(
    'SELECT shiftly_api.fn_clinical_triage_summary($1::integer,$2::jsonb) AS distribution',
    [actor, JSON.stringify(filters)],
  );
  return result.rows[0]?.distribution ?? null;
}

module.exports = { positiveId, triageFilters, triageRecordBody, attachTriageSnapshots, attachRunTriageSnapshots, loadTriageDistribution };
