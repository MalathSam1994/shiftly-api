// Path: d:\Cloned_REPOS\shiftly-api\routes\userAbsences.js
// (adjust base folder name if your API repo path is different)

const createCrudRouter = require('../createCrudRouter');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

const OPERATION_SOURCE = 'MANAGER_USER_ABSENCE_MANAGEMENT';

function formatUserAbsenceRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    start_date:
      row.start_date == null ? row.start_date : String(row.start_date).slice(0, 10),
    end_date:
      row.end_date == null ? row.end_date : String(row.end_date).slice(0, 10),
  };
}

function actorUserIdFromRequest(req) {
  const actorUserId = Number(req?.user?.id ?? req?.user?.sub);
  return Number.isInteger(actorUserId) && actorUserId > 0 ? actorUserId : null;
}

async function beginManagerAbsenceTransaction(pool, req) {
  const actorUserId = actorUserIdFromRequest(req);
  if (!actorUserId) {
    const err = new Error('Authenticated user context is required.');
    err.status = 401;
    err.code = 'AUTH_TOKEN_INVALID';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('shiftly.user_absence_operation_source', $1, true)`,
      [OPERATION_SOURCE],
    );
    await client.query(
      `SELECT set_config('shiftly.actor_user_id', $1, true)`,
      [String(actorUserId)],
    );
    await client.query(
      `SELECT set_config('shiftly.suppress_assignment_absence_notifications', '1', true)`,
    );
    return { client, actorUserId };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
    throw e;
  }
}

async function rollbackAndRelease(client) {
  if (!client) return;
  try { await client.query('ROLLBACK'); } catch (_) {}
  client.release();
}

function sendLocalError(req, res, err, fallback) {
  if (err?.status && err?.code) {
    return res.status(err.status).json({
      error: err.message || fallback,
      code: err.code,
    });
  }
  return sendPostgresError(req, res, err, {
    action: 'WRITE',
    label: fallback,
  });
}

const userAbsencesConfig = {
  table: 'shiftly_schema.user_absences',
  idColumn: 'id',
  columns: [
    'user_id',
    'absence_type',
    'start_date',
    'end_date',
    'created_by',
    'comment',
  ],
  listHandler: async (req, res, { pool, config }) => {
    const result = await pool.query(`
      SELECT
        id,
        user_id,
        absence_type,
        to_char(start_date, 'YYYY-MM-DD') AS start_date,
        to_char(end_date, 'YYYY-MM-DD') AS end_date,
        created_by,
        comment
      FROM ${config.table}
      ORDER BY ${config.idColumn}
    `);
    res.json(result.rows);
  },
  createHandler: async (req, res, { pool, config }) => {
    let client;
    const body = req.body || {};

    try {
      const tx = await beginManagerAbsenceTransaction(pool, req);
      client = tx.client;

      const result = await client.query(
        `
        INSERT INTO ${config.table}
          (user_id, absence_type, start_date, end_date, created_by, comment)
        VALUES
          ($1, upper($2::text), $3::date, $4::date, $5, $6)
        RETURNING
          id,
          user_id,
          absence_type,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          created_by,
          comment
        `,
        [
          body.user_id,
          body.absence_type,
          body.start_date,
          body.end_date,
          tx.actorUserId,
          body.comment ?? null,
        ],
      );

      await client.query('COMMIT');
      client.release();
      client = null;

      res.status(201).json(formatUserAbsenceRow(result.rows[0]));
    } catch (err) {
      await rollbackAndRelease(client);
      return sendLocalError(req, res, err, 'Error inserting user absence');
    }
  },
  updateHandler: async (req, res, { pool, config }) => {
    let client;
    const body = req.body || {};
    const sets = [];
    const values = [];
    let i = 1;

    for (const col of ['user_id', 'absence_type', 'start_date', 'end_date', 'comment']) {
      if (Object.prototype.hasOwnProperty.call(body, col)) {
        if (col === 'absence_type') {
          sets.push(`${col} = upper($${i}::text)`);
        } else if (col === 'start_date' || col === 'end_date') {
          sets.push(`${col} = $${i}::date`);
        } else {
          sets.push(`${col} = $${i}`);
        }
        values.push(col === 'comment' ? body[col] ?? null : body[col]);
        i++;
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No valid columns provided for update' });
    }

    values.push(req.params.id);

    try {
      const tx = await beginManagerAbsenceTransaction(pool, req);
      client = tx.client;

      const result = await client.query(
        `
        UPDATE ${config.table}
        SET ${sets.join(', ')},
            updated_at = CURRENT_TIMESTAMP
        WHERE ${config.idColumn} = $${i}
        RETURNING
          id,
          user_id,
          absence_type,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          created_by,
          comment
        `,
        values
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return res.status(404).json({ error: 'Not found' });
      }

      await client.query('COMMIT');
      client.release();
      client = null;

      res.json(formatUserAbsenceRow(result.rows[0]));
    } catch (err) {
      await rollbackAndRelease(client);
      return sendLocalError(req, res, err, 'Error updating user absence');
    }
  },
  deleteHandler: async (req, res, { pool, config }) => {
    let client;

    try {
      const tx = await beginManagerAbsenceTransaction(pool, req);
      client = tx.client;

      const result = await client.query(
        `
        DELETE FROM ${config.table}
        WHERE ${config.idColumn} = $1
        RETURNING
          id,
          user_id,
          absence_type,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          created_by,
          comment
        `,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return res.status(404).json({ error: 'Not found' });
      }

      await client.query('COMMIT');
      client.release();
      client = null;

      res.json({ deleted: formatUserAbsenceRow(result.rows[0]) });
    } catch (err) {
      await rollbackAndRelease(client);
      return sendLocalError(req, res, err, 'Error deleting user absence');
    }
  },
};

module.exports = createCrudRouter(userAbsencesConfig);

