const createCrudRouter = require('../createCrudRouter');

const {
  parseOptionalBoolean,
  sendActiveStatusError,
} = require('../utils/activeStatus');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isOnlyDepartmentStatusChange(body, currentRow) {
  if (!hasOwn(body, 'is_active')) {
    return false;
  }

  // The Flutter repository sends the complete object during update.
  // Therefore, department_desc may still be included even when only the
  // status switch was changed.
  if (!hasOwn(body, 'department_desc')) {
    return true;
  }

  return String(body.department_desc ?? '').trim() ===
      String(currentRow.department_desc ?? '').trim();
}


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



const departmentsConfig = {
  table: 'shiftly_schema.departments',
  idColumn: 'id',
  columns: ['department_desc', 'is_active'],
  activeFilter: true,
  updateHandler: async (req, res, { pool, config, allColumns }) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }

      const currentResult = await pool.query(
        `
        SELECT department_desc, is_active
        FROM ${config.table}
        WHERE ${config.idColumn} = $1
        `,
        [id],
      );

      if (!currentResult.rows || currentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      const currentDepartment = currentResult.rows[0];
      const onlyStatusChange = isOnlyDepartmentStatusChange(
        req.body,
        currentDepartment,
      );

      if (onlyStatusChange) {
        const isActive = parseOptionalBoolean(
          req.body.is_active,
          'is_active',
        );

        /*
         * Dedicated active/inactive update path.
         *
         * Do not run linked-record or department-description validations when
         * only is_active is being modified.
         */
        const statusResult = await pool.query(
          `
          UPDATE ${config.table}
          SET is_active = $1
          WHERE ${config.idColumn} = $2
          RETURNING ${allColumns.join(', ')}
          `,
          [isActive, id],
        );

        return res.json(statusResult.rows[0]);
      }

      /*
       * Normal department update path.
       *
       * Any existing database or route validation for department data remains
       * applicable when department_desc or another business field changes.
       */
      const sets = [];
      const values = [];
      let parameterIndex = 1;

      for (const column of config.columns) {
        if (!hasOwn(req.body, column)) {
          continue;
        }

        sets.push(`${column} = $${parameterIndex}`);
        values.push(
          column === 'is_active'
            ? parseOptionalBoolean(req.body[column], 'is_active')
            : req.body[column],
        );
        parameterIndex++;
      }

      if (sets.length === 0) {
        return res.status(400).json({
          error: 'No valid columns provided for update',
        });
      }

      values.push(id);

      const result = await pool.query(
        `
        UPDATE ${config.table}
        SET ${sets.join(', ')}
        WHERE ${config.idColumn} = $${parameterIndex}
        RETURNING ${allColumns.join(', ')}
        `,
        values,
      );

      if (!result.rows || result.rows.length === 0) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      if (sendActiveStatusError(res, err)) return;

      console.error('Error updating department:', err);

      const isBusiness = err && err.code === 'P0001';
      if (isBusiness) {
        const built = buildBusinessError(
          err,
          'Department cannot be updated because it is already linked.',
        );
        return res.status(built.http).json(built.body);
      }

      return res.status(500).json({
        error: 'Database error',
        details: err.message,
        code: err.code,
        routine: err.routine,
      });
    }
  },
  deleteHandler: async (req, res, { pool, config, allColumns }) => {
   try {
     const id = parseInt(req.params.id, 10);
     if (Number.isNaN(id)) {
       return res.status(400).json({ error: 'Invalid id.' });
     }
     const validation = await pool.query(
       `SELECT shiftly_api.validate_department_delete($1) AS result`,
       [id],
     );
     const validationResult = validation.rows?.[0]?.result;
     const ok =
       validationResult &&
       Object.prototype.hasOwnProperty.call(validationResult, 'ok')
         ? Boolean(validationResult.ok)
         : true;
     if (!ok) {
       return res.status(400).json({
         error: 'Business rule violation',
         details: 'Department cannot be deleted because it is already linked.',
         code: 'P0001',
         validation_errors: {
           errors: Array.isArray(validationResult?.errors)
             ? validationResult.errors
             : [],
           warnings: Array.isArray(validationResult?.warnings)
             ? validationResult.warnings
             : [],
         },
         errors: Array.isArray(validationResult?.errors)
           ? validationResult.errors
           : [],
         warnings: Array.isArray(validationResult?.warnings)
           ? validationResult.warnings
           : [],
       });
     }
     const result = await pool.query(
       `
       DELETE FROM ${config.table}
       WHERE ${config.idColumn} = $1
       RETURNING ${allColumns.join(', ')}
       `,
       [id],
     );
     if (!result.rows || result.rows.length === 0) {
       return res.status(404).json({ error: 'Not found' });
     }
     return res.json({ deleted: result.rows[0] });
   } catch (err) {
     console.error('Error deleting department:', err);
     const isBusiness = err && err.code === 'P0001';
     if (isBusiness) {
       const built = buildBusinessError(
         err,
         'Department cannot be deleted because it is already linked.',
       );
       return res.status(built.http).json(built.body);
     }
     return res.status(500).json({
       error: 'Database error',
       details: err.message,
       code: err.code,
       routine: err.routine,
     });
   }
 },
};

module.exports = createCrudRouter(departmentsConfig);
