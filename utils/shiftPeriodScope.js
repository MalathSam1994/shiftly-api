const pool = require('../db');

function actorUserId(req) {
  const userId = Number(req.user?.sub ?? req.user?.id);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

async function isAdminStaffType(userId, client = pool) {
  if (!userId) return false;
  const result = await client.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM shiftly_schema.users u
      JOIN shiftly_schema.staff_types st ON st.id = u.staff_type_id
      WHERE u.id = $1
        AND u.is_active = true
        AND st.is_active = true
        AND lower(trim(st.staff_type_name)) = 'admin'
    ) AS ok
    `,
    [userId],
  );
  return result.rows?.[0]?.ok === true;
}

async function canAccessDivisionDepartment({
  userId,
  divisionId,
  departmentId,
  client = pool,
}) {
  const divId = Number(divisionId);
  const deptId = Number(departmentId);
  if (!userId || !Number.isInteger(divId) || !Number.isInteger(deptId)) {
    return false;
  }

  const result = await client.query(
    `
    WITH actor AS (
      SELECT u.id, lower(trim(st.staff_type_name)) = 'admin' AS is_admin
      FROM shiftly_schema.users u
      LEFT JOIN shiftly_schema.staff_types st ON st.id = u.staff_type_id
      WHERE u.id = $1
        AND u.is_active = true
    )
    SELECT EXISTS (
      SELECT 1
      FROM actor a
      JOIN shiftly_schema.division_departments dd
        ON dd.division_id = $2
       AND dd.department_id = $3
       AND dd.is_active = true
      JOIN shiftly_schema.divisions dv
        ON dv.id = dd.division_id
       AND dv.is_active = true
      JOIN shiftly_schema.departments dep
        ON dep.id = dd.department_id
       AND dep.is_active = true
      WHERE a.is_admin
         OR EXISTS (
              SELECT 1
              FROM shiftly_schema.user_managers um
              WHERE um.manager_user_id = a.id
                AND um.division_id = dd.division_id
                AND um.department_id = dd.department_id
                AND um.is_active = true
            )
         OR (
              EXISTS (
                SELECT 1
                FROM shiftly_schema.user_divisions udv
                WHERE udv.user_id = a.id
                  AND udv.division_id = dd.division_id
                  AND udv.is_active = true
              )
              AND EXISTS (
                SELECT 1
                FROM shiftly_schema.user_department udp
                WHERE udp.user_id = a.id
                  AND udp.department_id = dd.department_id
                  AND udp.is_active = true
              )
            )
    ) AS ok
    `,
    [userId, divId, deptId],
  );
  return result.rows?.[0]?.ok === true;
}

async function requireDivisionDepartmentAccess(req, res, {
  divisionId,
  departmentId,
  code = 'SHIFT_PERIOD_SCOPE_DENIED',
} = {}) {
  const userId = actorUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    return false;
  }
  const ok = await canAccessDivisionDepartment({ userId, divisionId, departmentId });
  if (!ok) {
    res.status(403).json({
      error: 'You do not have access to this division and department.',
      code,
    });
    return false;
  }
  return true;
}

function scopedPeriodsWhere(alias, startIndex = 1) {
  return {
    sql: `
      (
        EXISTS (
          SELECT 1
          FROM shiftly_schema.users actor
          JOIN shiftly_schema.staff_types st ON st.id = actor.staff_type_id
          WHERE actor.id = $${startIndex}
            AND actor.is_active = true
            AND st.is_active = true
            AND lower(trim(st.staff_type_name)) = 'admin'
        )
        OR EXISTS (
          SELECT 1
          FROM shiftly_schema.user_managers um
          WHERE um.manager_user_id = $${startIndex}
            AND um.division_id = ${alias}.division_id
            AND um.department_id = ${alias}.department_id
            AND um.is_active = true
        )
        OR (
          EXISTS (
            SELECT 1
            FROM shiftly_schema.user_divisions udv
            WHERE udv.user_id = $${startIndex}
              AND udv.division_id = ${alias}.division_id
              AND udv.is_active = true
          )
          AND EXISTS (
            SELECT 1
            FROM shiftly_schema.user_department udp
            WHERE udp.user_id = $${startIndex}
              AND udp.department_id = ${alias}.department_id
              AND udp.is_active = true
          )
        )
      )
    `,
    params: [startIndex],
  };
}

module.exports = {
  actorUserId,
  canAccessDivisionDepartment,
  isAdminStaffType,
  requireDivisionDepartmentAccess,
  scopedPeriodsWhere,
};
