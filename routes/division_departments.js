const createCrudRouter = require('../createCrudRouter');

const divisionDepartmentsConfig = {
  table: 'shiftly_schema.division_departments',
  idColumn: 'id',
  columns: ['division_id', 'department_id', 'division_desc', 'department_desc'],
};

module.exports = createCrudRouter(divisionDepartmentsConfig);
