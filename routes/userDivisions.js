const createCrudRouter = require('../createCrudRouter');

const userDivisionsConfig = {
  table: 'shiftly_schema.user_divisions',
  idColumn: 'id',
  columns: ['user_id', 'division_id', 'division_desc'],
   // Support: GET /user-divisions?user_id=<id>
  listHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const userId = req.query.user_id;

      if (userId) {
        const query = `
          SELECT ${allColumns.join(', ')}
          FROM ${config.table}
          WHERE user_id = $1
          ORDER BY ${config.idColumn}
        `;
        const result = await pool.query(query, [userId]);
        res.json(result.rows);
        return;
      }

      // Default: return all rows
      const query = `
        SELECT ${allColumns.join(', ')}
        FROM ${config.table}
        ORDER BY ${config.idColumn}
      `;
      const result = await pool.query(query);
      res.json(result.rows);
    } catch (err) {
      console.error('Error querying DB (LIST user-divisions):', err);
      res.status(500).json({ error: 'Database error' });
    }
  },
};

module.exports = createCrudRouter(userDivisionsConfig);
