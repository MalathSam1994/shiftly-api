// routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { generateComplexPassword } = require('../services/passwordUtil');
const { sendUserWelcomeEmail } = require('../services/mailer');
const {
  activeStatusSqlWithInclude,
  parseIncludeIds,
  parseActiveStatusQuery,
  parseCreateIsActive,
  parseOptionalBoolean,
  sendActiveStatusError,
} = require('../utils/activeStatus');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');


const {
  enforceModuleLimit,
  isLicenseLimitError,
  buildLicenseLimitResponse,
} = require('../services/moduleLicense');



const router = express.Router();


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
    return {
      errors: Array.isArray(v.errors) ? v.errors : [],
      warnings: Array.isArray(v.warnings) ? v.warnings : [],
    };
  }

  return { errors: [], warnings: [] };
}

// Run a single query with a per-request statement_timeout that does NOT leak to pooled sessions.
async function queryWithTimeout(sql, params, timeoutMs = 20000) {
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

// GET /users -> list all users (without password_hash)
router.get('/', async (req, res) => {
	console.log(`[${req.rid}] USERS LIST entered`);
  try {
	  console.log(`[${req.rid}] USERS LIST before DB query`);
    const active = activeStatusSqlWithInclude({
      status: parseActiveStatusQuery(req.query),
      activeColumn: 'is_active',
      idColumn: 'id',
      startIndex: 1,
      includeIds: parseIncludeIds(req.query),
    });
    const where = active.clause ? `WHERE ${active.clause}` : '';

    const query = `
      SELECT id,
             empno,
             user_name,
             user_desc,
             role_id,
			 staff_type_id,
       email,
        must_change_password,
        is_active
      FROM shiftly_schema.users
      ${where}
      ORDER BY id
    `;
	
    // NOTE: do NOT send "SET ...; SELECT ..." as one string.
   // node-postgres returns an array of results for multi-statements -> result.rows becomes undefined.
   const result = await queryWithTimeout(query, active.params, 20000);

    console.log(`[${req.rid}] USERS LIST after DB query rows=${result.rows.length}`);
    res.json(result.rows);
  } catch (err) {
    if (sendActiveStatusError(res, err)) return;
    console.error('Error querying DB (USERS LIST):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /users/:id -> single user (without password_hash)
router.get('/:id', async (req, res) => {
	console.log(`[${req.rid}] USERS GET id=${req.params.id} entered`);
  try {
    const query = `
      SELECT id,
             empno,
             user_name,
             user_desc,
             role_id,
			 staff_type_id,
       email,
        must_change_password,
        is_active
      FROM shiftly_schema.users
      WHERE id = $1
    `;
      console.log(`[${req.rid}] USERS GET before DB query`);
   const result = await queryWithTimeout(query, [req.params.id], 20000);
   console.log(`[${req.rid}] USERS GET after DB query rows=${result.rows.length}`);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error querying DB (USERS GET BY ID):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /users -> create a new user with hashed password
router.post('/', async (req, res) => {
 const client = await pool.connect();
 try {
    const {
      empno,
      user_name,
      user_desc,
      role_id,
	  staff_type_id,
    email,
    is_active,
    } = req.body;

if (!user_name  || !email) {
      return res.status(400).json({
        error:
        'user_name and email are required to create a user.',
      });
    }


      const emailNorm = String(email).trim();
  if (!emailNorm) {
    return res.status(400).json({ error: 'email is required.' });
  }

   // ✅ Backend generates a strong random password (admin does NOT provide it).
   const isActive = parseCreateIsActive({ is_active });
   const tempPassword = generateComplexPassword(14);
   const hashedPassword = await bcrypt.hash(tempPassword, 10);
 

    const query = `
      INSERT INTO shiftly_schema.users
        (empno, user_name, user_desc, role_id, staff_type_id, email, password_hash, must_change_password, is_active)
      VALUES
        ($1,    $2,        $3,        $4,        $5,      $6,      $7,    TRUE, $8)
      RETURNING id,
                empno,
                user_name,
                user_desc,
                role_id,
				staff_type_id,
        email,
        must_change_password,
        is_active
    `;

    const values = [
     (empno ?? null),
      user_name,
      user_desc ?? null,
      role_id ?? null,
	  staff_type_id ?? null,
    emailNorm,
      hashedPassword,
      isActive,
    ];

    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '20000ms'`);

    // Backend-only module license validation.
    // Example: SHIFTLY_LICENSE_MAX_USERS=500
    // If 500 users already exist, creating user 501 is blocked here.
    await enforceModuleLimit(client, 'users');
    const result = await client.query(query, values);

    // ✅ Send email via Brevo SMTP with username + generated password
    await sendUserWelcomeEmail({
      to: emailNorm,
      username: result.rows[0].user_name,
      tempPassword,
    });

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
     try { await client.query('ROLLBACK'); } catch (_) {}

    if (sendActiveStatusError(res, err)) return;

    if (isLicenseLimitError(err)) {
      console.warn('User license limit reached:', {
        currentCount: err.currentCount,
        maxAllowed: err.maxAllowed,
      });

      const built = buildLicenseLimitResponse(err);
      return res.status(built.http).json(built.body);
    }


    console.error('Error inserting into DB (USERS CREATE):', err);
    return sendPostgresError(req, res, err, {
      action: 'CREATE',
      label: 'Error inserting into DB (USERS CREATE)',
    });
      } finally {
    client.release();
  }
});

// PUT /users/:id -> update user data (without changing password)
router.put('/:id', async (req, res) => {
  try {
    const {
      empno,
      user_name,
      user_desc,
      role_id,
	  staff_type_id,
    email,
    is_active,
    } = req.body;

    console.log(`[${req.rid}] USERS UPDATE id=${req.params.id} entered`);



    /*
     * Read the current row first.
     *
     * The Flutter client sends the complete user object when the administrator
     * clicks Deactivate/Reactivate. Therefore, checking only whether fields
     * exist in req.body is not enough to determine whether business data was
     * modified.
     *
     * We compare the submitted business fields with the stored values and run
     * validate_user_change only when at least one of those fields really
     * changed. An is_active-only update is intentionally allowed.
     */
    const currentResult = await queryWithTimeout(
      `
      SELECT id,
             empno,
             user_name,
             user_desc,
             role_id,
             staff_type_id,
             email,
             is_active
      FROM shiftly_schema.users
      WHERE id = $1
      `,
      [req.params.id],
      20000,
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    const currentUser = currentResult.rows[0];
    const hasField = (fieldName) =>
      Object.prototype.hasOwnProperty.call(req.body, fieldName);

    // Support both full PUT requests and status-only requests.
    const nextEmpno = hasField('empno')
      ? (empno ?? null)
      : currentUser.empno;
    const nextUserName = hasField('user_name')
      ? user_name
      : currentUser.user_name;
    const nextUserDesc = hasField('user_desc')
      ? (user_desc ?? null)
      : currentUser.user_desc;
    const nextRoleId = hasField('role_id')
      ? (role_id ?? null)
      : currentUser.role_id;
    const nextStaffTypeId = hasField('staff_type_id')
      ? (staff_type_id ?? null)
      : currentUser.staff_type_id;
    const nextEmail = hasField('email')
      ? (email ?? null)
      : currentUser.email;

    if (
      nextUserName == null ||
      String(nextUserName).trim().length === 0
    ) {
      return res.status(400).json({
        error: 'user_name is required for update.',
      });
    }


    const businessFieldsChanged =
      currentUser.empno !== nextEmpno ||
      currentUser.user_name !== nextUserName ||
      currentUser.user_desc !== nextUserDesc ||
      currentUser.role_id !== nextRoleId ||
      currentUser.staff_type_id !== nextStaffTypeId ||
      currentUser.email !== nextEmail;

    if (businessFieldsChanged) {
      const validationResult = await queryWithTimeout(
        `SELECT shiftly_api.validate_user_change($1, 'UPDATE') AS result`,
        [req.params.id],
        20000,
      );

      const validationPayload = validationResult.rows?.[0]?.result;
      const normalizedValidation =
        normalizeValidationErrors(validationPayload);
      const ok =
        validationPayload &&
        Object.prototype.hasOwnProperty.call(validationPayload, 'ok')
          ? Boolean(validationPayload.ok)
          : true;

      if (!ok) {
        return sendApiError(req, res, {
          status: 409,
          error: 'The record cannot be changed because it is referenced.',
          details:
            'User cannot be updated because this user is already linked.',
          code: 'RECORD_IN_USE',
          validation_errors: normalizedValidation,
          errors: normalizedValidation.errors,
          warnings: normalizedValidation.warnings,
        });
      }
    }

    const parsedIsActive = hasField('is_active')
      ? parseOptionalBoolean(is_active, 'is_active')
      : undefined;
    const sets = [
      'empno = $1',
      'user_name = $2',
      'user_desc = $3',
      'role_id = $4',
      'staff_type_id = $5',
      'email = $6',
    ];
    const values = [
      nextEmpno,
      nextUserName,
      nextUserDesc,
      nextRoleId,
      nextStaffTypeId,
      nextEmail,
    ];



    let nextIndex = 7;

    if (parsedIsActive !== undefined) {
      sets.push(`is_active = $${nextIndex}`);
      values.push(parsedIsActive);
      nextIndex += 1;
    }

    values.push(req.params.id);

    const query = `
      UPDATE shiftly_schema.users
      SET ${sets.join(', ')}
     WHERE id = $${nextIndex}
      RETURNING id,
                empno,
                user_name,
                user_desc,
                role_id,
               staff_type_id,
               email,
               must_change_password,
               is_active
    `;

    const result = await pool.query(query, values);

    console.log(`[${req.rid}] USERS UPDATE result rows=${result.rows.length}`);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (sendActiveStatusError(res, err)) return;
    console.error('Error updating DB (USERS UPDATE):', err);
    return sendPostgresError(req, res, err, {
      action: 'UPDATE',
      label: 'Error updating DB (USERS UPDATE)',
    });
  }
});

// DELETE /users/:id -> delete user
router.delete('/:id', async (req, res) => {
  try {
    const validationResult = await queryWithTimeout(
      `SELECT shiftly_api.validate_user_change($1, 'DELETE') AS result`,
      [req.params.id],
      20000,
    );

    const validationPayload = validationResult.rows?.[0]?.result;
    const normalizedValidation = normalizeValidationErrors(validationPayload);
    const ok =
      validationPayload &&
      Object.prototype.hasOwnProperty.call(validationPayload, 'ok')
        ? Boolean(validationPayload.ok)
        : true;

    if (!ok) {
      return sendApiError(req, res, {
        status: 409,
        error: 'The record cannot be deleted because it is referenced.',
        details: `User cannot be deleted because this user is already linked.`,
        code: 'RECORD_IN_USE',
        validation_errors: normalizedValidation,
        errors: normalizedValidation.errors,
        warnings: normalizedValidation.warnings,
      });
    }

    const query = `
      DELETE FROM shiftly_schema.users
      WHERE id = $1
      RETURNING id,
                empno,
                user_name,
                user_desc,
                role_id,
				staff_type_id,
         email
    `;
    const result = await pool.query(query, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting from DB (USERS DELETE):', err);
    return sendPostgresError(req, res, err, {
      action: 'DELETE',
      label: 'Error deleting from DB (USERS DELETE)',
    });
  }
});

module.exports = router;
