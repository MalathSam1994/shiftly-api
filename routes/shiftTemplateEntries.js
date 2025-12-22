// routes/shiftTemplateEntries.js
const createCrudRouter = require('../createCrudRouter');

const shiftTemplateEntriesConfig = {
  table: 'shiftly_schema.shift_template_entries',
  idColumn: 'id',
 columns: [
   'template_id',
   'division_id',
   'department_id',
   'staff_type_id',
   'user_id',
   'shift_type_id',
   'day_of_week',
   'week_of_cycle',
 ],
};

module.exports = createCrudRouter(shiftTemplateEntriesConfig);
