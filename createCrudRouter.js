// createCrudRouter.js
const express = require('express');
const pool = require('./db');
const {
  activeStatusSqlWithInclude,
  parseIncludeIds,
  parseActiveStatusQuery,
  parseCreateIsActive,
  parseOptionalBoolean,
  sendActiveStatusError,
} = require('./utils/activeStatus');
const { sendApiError } = require('./utils/apiError');
const { sendPostgresError } = require('./utils/postgresErrorMapper');

// Run a single query with a per-request statement_timeout that does NOT leak to pooled sessions.
async function queryWithTimeout(sql, params = [], timeoutMs = 20000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL only applies within the current transaction.
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

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
  const timeoutMs = config.timeoutMs ?? 20000;
  const activeColumn = config.activeColumn || 'is_active';

  function activeStatusClause(req, params, nextIndex) {
    if (!config.activeFilter) {
      return { clause: '', nextIndex };
    }

    const active = activeStatusSqlWithInclude({
      status: parseActiveStatusQuery(req.query),
      activeColumn,
      idColumn: config.idColumn,
      startIndex: nextIndex,
      includeIds: parseIncludeIds(req.query),
    });
    params.push(...active.params);
    return { clause: active.clause, nextIndex: active.nextIndex };
  }

  // GET / -> list all rows
  router.get('/', async (req, res) => {
    try {
		
		      // Allow per-route custom list handler (filtering/pagination/etc.)
     if (typeof config.listHandler === 'function') {
       await config.listHandler(req, res, { pool, config, allColumns });
       return;
     }

      const params = [];
      const active = activeStatusClause(req, params, 1);
      const where = active.clause ? `WHERE ${active.clause}` : '';
      const query = `
        SELECT ${allColumns.join(', ')}
        FROM ${config.table}
        ${where}
        ORDER BY ${config.idColumn}
      `;
      const result = await queryWithTimeout(query, params, timeoutMs);
      res.json(result.rows);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      sendPostgresError(req, res, err, {
        action: 'LIST',
        label: 'Error querying DB (LIST)',
      });
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
        const result = await queryWithTimeout(query, [req.params.id], timeoutMs);

      if (result.rows.length === 0) {
        return sendApiError(req, res, {
          status: 404,
          error: 'The requested record could not be found.',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json(result.rows[0]);
    } catch (err) {
      sendPostgresError(req, res, err, {
        action: 'GET',
        label: 'Error querying DB (GET BY ID)',
      });
    }
  });

  // POST / -> insert (any subset of allowed columns)
  router.post('/', async (req, res) => {
    try {
		    // Allow per-route custom create handler
     if (typeof config.createHandler === 'function') {
       await config.createHandler(req, res, { pool, config, allColumns });
       return;
     }
		
      const cols = [];
      const placeholders = [];
      const values = [];
      let i = 1;

      for (const col of config.columns) {
        if (Object.prototype.hasOwnProperty.call(req.body, col)) {
          cols.push(col);
          placeholders.push(`$${i}`);
          values.push(
            col === activeColumn
              ? parseCreateIsActive({ is_active: req.body[col] })
              : req.body[col],
          );
          i++;
        }
      }

      if (cols.length === 0) {
        return sendApiError(req, res, {
          status: 400,
          error: 'No valid fields were provided.',
          code: 'INVALID_REQUEST',
        });
      }

     // Support string IDs (e.g., code tables) by allowing the caller to provide idColumn in body too
   // when idColumn is not serial. If present, include it in the INSERT.
   if (
     config.idColumn &&
     Object.prototype.hasOwnProperty.call(req.body, config.idColumn)
   ) {
     cols.unshift(config.idColumn);
     placeholders.unshift(`$${i}`);
     values.push(req.body[config.idColumn]);
     i++;
   }

   const query = `
     INSERT INTO ${config.table} (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING ${allColumns.join(', ')}
   `;

       const result = await queryWithTimeout(query, values, timeoutMs);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      sendPostgresError(req, res, err, {
        action: 'CREATE',
        label: 'Error inserting into DB (CREATE)',
      });
    }
  });

  // PUT /:id -> update (any subset of allowed columns)
  router.put('/:id', async (req, res) => {
    try {

      // Allow lightweight pre-validation hook while still using generic update flow.
      if (typeof config.beforeUpdate === 'function') {
        const shouldContinue = await config.beforeUpdate(req, res, {
          pool,
          config,
          allColumns,
        });
        if (shouldContinue === false) {
          return;
        }
      }

      // Allow per-route custom update handler
      if (typeof config.updateHandler === 'function') {
        await config.updateHandler(req, res, { pool, config, allColumns });
        return;
      }


      const sets = [];
      const values = [];
      let i = 1;

      for (const col of config.columns) {
        if (Object.prototype.hasOwnProperty.call(req.body, col)) {
          sets.push(`${col} = $${i}`);
          values.push(
            col === activeColumn
              ? parseOptionalBoolean(req.body[col], activeColumn)
              : req.body[col],
          );
          i++;
        }
      }

      if (sets.length === 0) {
        return sendApiError(req, res, {
          status: 400,
          error: 'No valid fields were provided.',
          code: 'INVALID_REQUEST',
        });
      }

      values.push(req.params.id);
      const query = `
        UPDATE ${config.table}
        SET ${sets.join(', ')}
        WHERE ${config.idColumn} = $${i}
        RETURNING ${allColumns.join(', ')}
      `;

       const result = await queryWithTimeout(query, values, timeoutMs);

      if (result.rows.length === 0) {
        return sendApiError(req, res, {
          status: 404,
          error: 'The requested record could not be found.',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json(result.rows[0]);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;
      if (typeof config.mapDbError === 'function') {
        const mapped = config.mapDbError(err, {
          action: 'UPDATE',
          req,
          res,
          pool,
          config,
          allColumns,
        });
        if (mapped && mapped.http && mapped.body) {
          return res.status(mapped.http).json(mapped.body);
        }
      }


      sendPostgresError(req, res, err, {
        action: 'UPDATE',
        label: 'Error updating DB (UPDATE)',
      });
    }
  });

  // DELETE /:id
  router.delete('/:id', async (req, res) => {
    try {
      // Allow lightweight pre-validation hook while still using generic delete flow.
      if (typeof config.beforeDelete === 'function') {
        const shouldContinue = await config.beforeDelete(req, res, {
          pool,
          config,
          allColumns,
        });
        if (shouldContinue === false) {
          return;
        }
      }
      // Allow per-route custom delete handler
      if (typeof config.deleteHandler === 'function') {
        await config.deleteHandler(req, res, { pool, config, allColumns });
        return;
      }
      const query = `
        DELETE FROM ${config.table}
        WHERE ${config.idColumn} = $1
        RETURNING ${allColumns.join(', ')}
      `;
       const result = await queryWithTimeout(query, [req.params.id], timeoutMs);

      if (result.rows.length === 0) {
        return sendApiError(req, res, {
          status: 404,
          error: 'The requested record could not be found.',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json({ deleted: result.rows[0] });
    } catch (err) {
      if (typeof config.mapDbError === 'function') {
        const mapped = config.mapDbError(err, {
          action: 'DELETE',
          req,
          res,
          pool,
          config,
          allColumns,
        });
        if (mapped && mapped.http && mapped.body) {
          return res.status(mapped.http).json(mapped.body);
        }
      }

      sendPostgresError(req, res, err, {
        action: 'DELETE',
        label: 'Error deleting from DB (DELETE)',
      });
    }
  });

  return router;
}

module.exports = createCrudRouter;
