// routes/roles.js
const createCrudRouter = require('../createCrudRouter');

const rolesConfig = {
  table: 'shiftly_schema.roles',
  idColumn: 'id',
  columns: ['role_code', 'role_name', 'role_desc', 'is_active'],
  activeFilter: true,
};

module.exports = createCrudRouter(rolesConfig);

