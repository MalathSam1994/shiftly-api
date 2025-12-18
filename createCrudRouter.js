// createCrudRouter.js
const express = require('express');
const pool = require('./db');

/**
 * config = {
 *   table: 'shiftly_schema.tree_menu',
 *   idColumn: 'screen_id',
 *   columns: ['parent_id','screen_type','screen_file_name','menu_label']
 * }
 */
function createCrudRouter(config) {
  const router = express.Router();

  const allColumns = [config.idColumn, ...config.columns];

  // GET / -> list all rows
  router.get('/', async (req, res) => {
    try {
		
		      // Allow per-route custom list handler (filtering/pagination/etc.)
     if (typeof config.listHandler === 'function') {
       await config.listHandler(req, res, { pool, config, allColumns });
       return;
     }

      const query = `
        SELECT ${allColumns.join(', ')}
        FROM ${config.table}
        ORDER BY ${config.idColumn}
      `;
      const result = await pool.query(query);
      res.json(result.rows);
    } catch (err) {
      console.error('Error querying DB (LIST):', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // GET /:id -> single row
  router.get('/:id', async (req, res) => {
    try {
      const query = `
        SELECT ${allColumns.join(', ')}
        FROM ${config.table}
        WHERE ${config.idColumn} = $1
      `;
      const result = await pool.query(query, [req.params.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error querying DB (GET BY ID):', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // POST / -> insert (any subset of allowed columns)
  router.post('/', async (req, res) => {
    try {
      const cols = [];
      const placeholders = [];
      const values = [];
      let i = 1;

      for (const col of config.columns) {
        if (Object.prototype.hasOwnProperty.call(req.body, col)) {
          cols.push(col);
          placeholders.push(`$${i}`);
          values.push(req.body[col]);
          i++;
        }
      }

      if (cols.length === 0) {
        return res
          .status(400)
          .json({ error: 'No valid columns provided for insert' });
      }

      const query = `
        INSERT INTO ${config.table} (${cols.join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING ${allColumns.join(', ')}
      `;

      const result = await pool.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('Error inserting into DB (CREATE):', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // PUT /:id -> update (any subset of allowed columns)
  router.put('/:id', async (req, res) => {
    try {
      const sets = [];
      const values = [];
      let i = 1;

      for (const col of config.columns) {
        if (Object.prototype.hasOwnProperty.call(req.body, col)) {
          sets.push(`${col} = $${i}`);
          values.push(req.body[col]);
          i++;
        }
      }

      if (sets.length === 0) {
        return res
          .status(400)
          .json({ error: 'No valid columns provided for update' });
      }

      values.push(req.params.id);
      const query = `
        UPDATE ${config.table}
        SET ${sets.join(', ')}
        WHERE ${config.idColumn} = $${i}
        RETURNING ${allColumns.join(', ')}
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error updating DB (UPDATE):', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  // DELETE /:id
  router.delete('/:id', async (req, res) => {
    try {
      const query = `
        DELETE FROM ${config.table}
        WHERE ${config.idColumn} = $1
        RETURNING ${allColumns.join(', ')}
      `;
      const result = await pool.query(query, [req.params.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.json({ deleted: result.rows[0] });
    } catch (err) {
      console.error('Error deleting from DB (DELETE):', err);
      res.status(500).json({ error: 'Database error' });
    }
  });

  return router;
}

module.exports = createCrudRouter;
