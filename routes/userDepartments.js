const createCrudRouter = require('../createCrudRouter');

const userDepartmentsConfig = {
  table: 'shiftly_schema.user_department',
  idColumn: 'id',
  columns: ['user_id', 'department_id', 'department_desc'],
};

module.exports = createCrudRouter(userDepartmentsConfig);
