// routes/shiftTypes.js
const createCrudRouter = require('../createCrudRouter');

const shiftTypesConfig = {
  table: 'shiftly_schema.shift_types',
  idColumn: 'id',
  columns: [
    'shift_code',
    'shift_label',
    'start_time',
    'end_time',
    'duration_hours',
    'day_type',
    'notes',
  ],
};

module.exports = createCrudRouter(shiftTypesConfig);
