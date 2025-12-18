const createCrudRouter = require('../createCrudRouter');

const departmentsConfig = {
  table: 'shiftly_schema.departments',
  idColumn: 'id',
  columns: ['department_desc'],
};

module.exports = createCrudRouter(departmentsConfig);
