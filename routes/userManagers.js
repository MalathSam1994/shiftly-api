// routes/userManagers.js
const createCrudRouter = require('../createCrudRouter');

const userManagersConfig = {
  table: 'shiftly_schema.user_managers',
  idColumn: 'id',
  columns: ['user_id', 'manager_user_id', 'is_primary'],
};

module.exports = createCrudRouter(userManagersConfig);
