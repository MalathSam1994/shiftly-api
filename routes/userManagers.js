// routes/userManagers.js
const createCrudRouter = require('../createCrudRouter');

function tryParseJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function normalizeValidationErrors(anyVal) {
  let v = anyVal;

  if (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    v.validation_errors !== undefined
  ) {
    v = v.validation_errors;
  }

  if (Array.isArray(v)) {
    return { errors: v, warnings: [] };
  }

  if (v && typeof v === 'object') {
    const errors = Array.isArray(v.errors) ? v.errors : [];
    const warnings = Array.isArray(v.warnings) ? v.warnings : [];

    if (!errors.length && !warnings.length && Array.isArray(v.validation_errors)) {
      return { errors: v.validation_errors, warnings: [] };
    }

    return { errors, warnings };
  }

  return { errors: [], warnings: [] };
}

function buildBusinessError(err, fallbackMessage) {
  const parsedDetail = tryParseJson(err && err.detail);
  const normalized = normalizeValidationErrors(parsedDetail);

  return {
    http: 400,
    body: {
      error: 'Business rule violation',
      details:
        (err && err.message)
          ? err.message
          : (fallbackMessage || 'Business rule violation.'),
      code: (err && err.code) ? err.code : 'P0001',
      routine: err && err.routine,
      validation_errors:
        (normalized.errors.length || normalized.warnings.length)
          ? normalized
          : undefined,
      errors: normalized.errors,
      warnings: normalized.warnings,
      db_detail: err && err.detail,
    },
  };
}

async function validateUserManagerChange(client, {
  id,
  action,
  userId = null,
  managerUserId = null,
  isPrimary = null,
}) {
  const validation = await client.query(
    `
      SELECT shiftly_api.validate_user_manager_change(
        $1,
        $2,
        $3,
        $4,
        $5
      ) AS result
    `,
    [id, action, userId, managerUserId, isPrimary],
  );

  const result = validation.rows?.[0]?.result ?? null;
  const ok =
    result &&
    Object.prototype.hasOwnProperty.call(result, 'ok')
      ? Boolean(result.ok)
      : true;

  return { ok, result };
}

function buildValidationResponse(result, fallbackDetails) {
  return {
    error: 'Business rule violation',
    details: fallbackDetails,
    code: 'P0001',
    validation_errors: {
      errors: Array.isArray(result?.errors) ? result.errors : [],
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    },
    errors: Array.isArray(result?.errors) ? result.errors : [],
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
  };
}



const userManagersConfig = {
  table: 'shiftly_schema.user_managers',
  idColumn: 'id',
  columns: ['user_id', 'manager_user_id', 'is_primary'],
 updateHandler: async (req, res, { pool, config, allColumns }) => {
   const id = parseInt(req.params.id, 10);
   if (Number.isNaN(id)) {
     return res.status(400).json({ error: 'Invalid id.' });
   }

   const client = await pool.connect();
   try {
     await client.query('BEGIN');

     const currentResult = await client.query(
       `
         SELECT ${allColumns.join(', ')}
         FROM ${config.table}
         WHERE ${config.idColumn} = $1
       `,
       [id],
     );

     if (!currentResult.rows.length) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'Not found' });
     }

     const current = currentResult.rows[0];
     const newUserId = Object.prototype.hasOwnProperty.call(req.body, 'user_id')
       ? req.body.user_id
       : current.user_id;
     const newManagerUserId = Object.prototype.hasOwnProperty.call(req.body, 'manager_user_id')
       ? req.body.manager_user_id
       : current.manager_user_id;
     const newIsPrimary = Object.prototype.hasOwnProperty.call(req.body, 'is_primary')
       ? req.body.is_primary
       : current.is_primary;

     const noChange =
       Number(newUserId) === Number(current.user_id) &&
       Number(newManagerUserId) === Number(current.manager_user_id) &&
       Boolean(newIsPrimary) === Boolean(current.is_primary);

     if (noChange) {
       await client.query('COMMIT');
       return res.json(current);
     }

     const validation = await validateUserManagerChange(client, {
       id,
       action: 'UPDATE',
       userId: newUserId,
       managerUserId: newManagerUserId,
       isPrimary: newIsPrimary,
     });

     if (!validation.ok) {
       await client.query('ROLLBACK');
       return res.status(400).json(
         buildValidationResponse(
           validation.result,
           'User-manager relation cannot be updated because it is still linked to open shift requests.',
         ),
       );
     }

     await client.query(
       `
         SELECT shiftly_api.apply_user_manager_change_to_shift_requests(
           $1,
           $2,
           $3,
           $4,
           $5
         )
       `,
       [id, 'UPDATE', newUserId, newManagerUserId, newIsPrimary],
     );

     const updatedResult = await client.query(
       `
         UPDATE ${config.table}
         SET user_id = $1,
             manager_user_id = $2,
             is_primary = $3
         WHERE ${config.idColumn} = $4
         RETURNING ${allColumns.join(', ')}
       `,
       [newUserId, newManagerUserId, newIsPrimary, id],
     );

     await client.query('COMMIT');
     return res.json(updatedResult.rows[0]);
   } catch (err) {
     try { await client.query('ROLLBACK'); } catch (_) {}
     console.error('Error updating user manager:', err);

     const isBusiness = err && err.code === 'P0001';
     if (isBusiness) {
       const built = buildBusinessError(
         err,
         'User-manager relation cannot be updated.',
       );
       return res.status(built.http).json(built.body);
     }

     return res.status(500).json({
       error: 'Database error',
       details: err.message,
       code: err.code,
       routine: err.routine,
     });
   } finally {
     client.release();
   }
 },

 deleteHandler: async (req, res, { pool, config, allColumns }) => {
   const id = parseInt(req.params.id, 10);
   if (Number.isNaN(id)) {
     return res.status(400).json({ error: 'Invalid id.' });
   }

   const client = await pool.connect();
   try {
     await client.query('BEGIN');

     const currentResult = await client.query(
       `
         SELECT ${allColumns.join(', ')}
         FROM ${config.table}
         WHERE ${config.idColumn} = $1
       `,
       [id],
     );

     if (!currentResult.rows.length) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'Not found' });
     }

     const validation = await validateUserManagerChange(client, {
       id,
       action: 'DELETE',
     });

     if (!validation.ok) {
       await client.query('ROLLBACK');
       return res.status(400).json(
         buildValidationResponse(
           validation.result,
           'User-manager relation cannot be deleted because it is still linked to open shift requests.',
         ),
       );
     }

     await client.query(
       `
         SELECT shiftly_api.apply_user_manager_change_to_shift_requests(
           $1,
           $2,
           $3,
           $4,
           $5
         )
       `,
       [id, 'DELETE', null, null, null],
     );

     const deletedResult = await client.query(
       `
         DELETE FROM ${config.table}
         WHERE ${config.idColumn} = $1
         RETURNING ${allColumns.join(', ')}
       `,
       [id],
     );

     await client.query('COMMIT');
     return res.json({ deleted: deletedResult.rows[0] });
   } catch (err) {
     try { await client.query('ROLLBACK'); } catch (_) {}
     console.error('Error deleting user manager:', err);

     const isBusiness = err && err.code === 'P0001';
     if (isBusiness) {
       const built = buildBusinessError(
         err,
         'User-manager relation cannot be deleted.',
       );
       return res.status(built.http).json(built.body);
     }

     return res.status(500).json({
       error: 'Database error',
       details: err.message,
       code: err.code,
       routine: err.routine,
     });
   } finally {
     client.release();
   }
 },
};

module.exports = createCrudRouter(userManagersConfig);
