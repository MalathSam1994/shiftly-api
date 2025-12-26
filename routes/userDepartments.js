const createCrudRouter = require('../createCrudRouter');

const userDepartmentsConfig = {
  table: 'shiftly_schema.user_department',
  idColumn: 'id',
  columns: ['user_id', 'department_id', 'department_desc'],
    // Support: GET /user-departments?user_id=<id>
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
      console.error('Error querying DB (LIST user-departments):', err);
      res.status(500).json({ error: 'Database error' });
    }
  },
};

module.exports = createCrudRouter(userDepartmentsConfig);
