// routes/staffShiftRules.js
const createCrudRouter = require('../createCrudRouter');

const staffShiftRulesConfig = {
  table: 'shiftly_schema.staff_shift_rules',
  idColumn: 'id',
  columns: ['department_id', 'staff_type_id', 'shift_type_id', 'required_staff_count'],
};

module.exports = createCrudRouter(staffShiftRulesConfig);
