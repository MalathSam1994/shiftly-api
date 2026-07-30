// middleware/requirePermission.js
const pool = require('../db');
const { sendApiError } = require('../utils/apiError');
const { sendPostgresError } = require('../utils/postgresErrorMapper');

function requirePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const userId = Number(req.user?.sub ?? req.user?.id);
      if (!userId) {
        return sendApiError(req, res, {
          status: 401,
          error: 'Please sign in to continue.',
          code: 'AUTH_REQUIRED',
        });
      }

      const { rows } = await pool.query(
        `SELECT shiftly_api.fn_user_has_permission($1, $2) AS ok`,
        [userId, permissionKey]
      );

      if (!rows?.[0]?.ok) {
        return sendApiError(req, res, {
          status: 403,
          error: 'You do not have permission to perform this action.',
          code: 'PERMISSION_DENIED',
          extra: { permission: permissionKey },
        });
      }

      next();
    } catch (e) {
      return sendPostgresError(req, res, e, {
        label: 'Permission check failed',
      });
    }
  };
}

module.exports = requirePermission;
