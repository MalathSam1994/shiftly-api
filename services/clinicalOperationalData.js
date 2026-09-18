// Legacy database provenance stays intact; these are presentation-only labels.
const configurationLabels = new Set([
  'rule_name', 'rule_set_name', 'rule_set_label', 'acuity_rule_set_label',
  'policy_name', 'competency_name', 'factor_name', 'event_name', 'unit_name',
]);
const initializedNotes = new Map([
  ['Seeded demo acuity factor value.', 'Recorded acuity factor value.'],
  ['Seeded demo ADT burden.', 'Recorded ADT burden.'],
  ['Seeded demo clinical competency.', 'Recorded clinical competency.'],
]);

function clinicalPresentation(value, key = '', parent = '') {
  if (Array.isArray(value)) return value.map(item => clinicalPresentation(item, key, parent));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([field]) => field !== 'demo' && field !== 'is_demo' && !field.endsWith('_is_demo'))
      .map(([field, item]) => [field, clinicalPresentation(item, field, key)]));
  }
  if (typeof value !== 'string') return value;
  if ((key === 'origin' || key.endsWith('source_type')) && value === 'DEMO') return 'RECORDED';
  if (configurationLabels.has(key) || (key === 'name' && /rule_set|policy/.test(parent))
      || (key === 'description' && /^(event|factor|rule_set|policy|competency|unit)$/.test(parent))) {
    return value.replace(/^Demo[\s/]+/i, '');
  }
  if (['input_notes', 'notes', 'comment'].includes(key)) return initializedNotes.get(value) ?? value;
  return value;
}

function clinicalOperationalData(req, res, next) {
  // Old clients may still submit these fields, including an initial encounter.
  for (const body of [req.body, req.body?.encounter]) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    delete body.is_demo;
    if (String(body.source_type || '').trim().toUpperCase() === 'DEMO') body.source_type = 'MANUAL';
  }
  const json = res.json.bind(res);
  res.json = body => json(clinicalPresentation(body));
  next();
}

module.exports = { clinicalOperationalData, clinicalPresentation };
