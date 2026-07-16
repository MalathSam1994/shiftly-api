// routes/shiftTemplates.js
const createCrudRouter = require('../createCrudRouter');
const {
  activeStatusSqlWithInclude,
  parseIncludeIds,
  parseActiveStatusQuery,
  parseCreateIsActive,
  parseOptionalBoolean,
  sendActiveStatusError,
} = require('../utils/activeStatus');

const shiftTemplatesConfig = {
  table: 'shiftly_schema.shift_templates',
  idColumn: 'id',
  columns: [
    'template_name',
    'pattern_type',
    'cycle_length_weeks',
    'cycle_anchor_date',
    'is_active',
    'description',
  ],
  activeFilter: true,
    listHandler: async (req, res, { pool, config }) => {
    try {
      const active = activeStatusSqlWithInclude({
        status: parseActiveStatusQuery(req.query),
        activeColumn: 'is_active',
        idColumn: 'id',
        startIndex: 1,
        includeIds: parseIncludeIds(req.query),
      });
      const where = active.clause ? `WHERE ${active.clause}` : '';

      const result = await pool.query(`
        SELECT
          id,
          template_name,
          pattern_type,
          cycle_length_weeks,
          to_char(cycle_anchor_date, 'YYYY-MM-DD') AS cycle_anchor_date,
          is_active,
          description
        FROM ${config.table}
        ${where}
        ORDER BY ${config.idColumn}
      `, active.params);
      res.json(result.rows);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      throw err;
    }
  },
  createHandler: async (req, res, { pool, config }) => {
    const body = req.body || {};
    const cols = config.columns.filter((c) =>
      Object.prototype.hasOwnProperty.call(body, c)
    );

    if (cols.length === 0) {
      return res.status(400).json({ error: 'No valid columns provided for insert' });
    }

    const values = cols.map((c) =>
      c === 'is_active'
        ? parseCreateIsActive({ is_active: body[c] })
        : body[c],
    );
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    const result = await pool.query(
      `
      INSERT INTO ${config.table} (${cols.join(', ')})
      VALUES (${placeholders})
      RETURNING
        id,
        template_name,
        pattern_type,
        cycle_length_weeks,
        to_char(cycle_anchor_date, 'YYYY-MM-DD') AS cycle_anchor_date,
        is_active,
        description
      `,
      values
    );

    res.status(201).json(result.rows[0]);
  },
  updateHandler: async (req, res, { pool, config }) => {
    const body = req.body || {};
    const sets = [];
    const values = [];
    let i = 1;

    for (const col of config.columns) {
      if (Object.prototype.hasOwnProperty.call(body, col)) {
        sets.push(`${col} = $${i}`);
        values.push(
          col === 'is_active'
            ? parseOptionalBoolean(body[col], 'is_active')
            : body[col],
        );
        i++;
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No valid columns provided for update' });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `
      UPDATE ${config.table}
      SET ${sets.join(', ')}
      WHERE ${config.idColumn} = $${i}
      RETURNING
        id,
        template_name,
        pattern_type,
        cycle_length_weeks,
        to_char(cycle_anchor_date, 'YYYY-MM-DD') AS cycle_anchor_date,
        is_active,
        description
      `,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  },
  deleteHandler: async (req, res, { pool, config }) => {
    const result = await pool.query(
      `
      DELETE FROM ${config.table}
      WHERE ${config.idColumn} = $1
      RETURNING
        id,
        template_name,
        pattern_type,
        cycle_length_weeks,
        to_char(cycle_anchor_date, 'YYYY-MM-DD') AS cycle_anchor_date,
        is_active,
        description
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({ deleted: result.rows[0] });
  },
};

module.exports = createCrudRouter(shiftTemplatesConfig);
