// routes/staffTypes.js
const createCrudRouter = require('../createCrudRouter');

const staffTypesConfig = {
  table: 'shiftly_schema.staff_types',
  idColumn: 'id',
  columns: ['staff_type_name'],
};

module.exports = createCrudRouter(staffTypesConfig);
