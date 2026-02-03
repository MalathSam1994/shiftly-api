const createCrudRouter = require('../createCrudRouter');

// Code table: shiftly_schema.absence_types
const absenceTypesConfig = {
  table: 'shiftly_schema.absence_types',
  idColumn: 'code',
  columns: ['description', 'is_active', 'sort_order'],
  // Optional: keep list stable for UI
  listHandler: async (req, res, ctx) => {
    const { config } = ctx;
    const onlyActive = String(req.query.onlyActive ?? '').toLowerCase();
    const where = onlyActive === 'true' ? 'WHERE is_active = TRUE' : '';
    const q = `
      SELECT code, description, is_active, sort_order, created_at, updated_at
        FROM ${config.table}
      ${where}
       ORDER BY is_active DESC, sort_order ASC, code ASC
    `;
    const result = await ctx.pool.query(q);
    res.json(result.rows);
  },
};

module.exports = createCrudRouter(absenceTypesConfig);
