const createCrudRouter = require('../createCrudRouter');
const {
  activeStatusSql,
  parseActiveStatusQuery,
  sendActiveStatusError,
} = require('../utils/activeStatus');

const userDivisionsConfig = {
  table: 'shiftly_schema.user_divisions',
  idColumn: 'id',
  columns: ['user_id', 'division_id', 'division_desc', 'is_active'],
  activeFilter: true,
   // Support: GET /user-divisions?user_id=<id>
  listHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const userId = req.query.user_id;
      const active = activeStatusSql(parseActiveStatusQuery(req.query), 'is_active', userId ? 2 : 1);

      if (userId) {
        const params = [userId, ...active.params];
        const activeClause = active.clause ? `AND ${active.clause}` : '';

        const query = `
          SELECT ${allColumns.join(', ')}
          FROM ${config.table}
          WHERE user_id = $1
          ${activeClause}
          ORDER BY ${config.idColumn}
        `;
        const result = await pool.query(query, params);
        res.json(result.rows);
        return;
      }

      // Default: return all rows
      const query = `
        SELECT ${allColumns.join(', ')}
        FROM ${config.table}
        ${active.clause ? `WHERE ${active.clause}` : ''}
        ORDER BY ${config.idColumn}
      `;
      const result = await pool.query(query, active.params);
      res.json(result.rows);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      console.error('Error querying DB (LIST user-divisions):', err);
      res.status(500).json({ error: 'Database error' });
    }
  },
};

module.exports = createCrudRouter(userDivisionsConfig);
