const createCrudRouter = require('../createCrudRouter');

const holidayYearsConfig = {
  table: 'shiftly_schema.holiday_years',
  idColumn: 'id',
  columns: ['year', 'is_active'],
  activeFilter: true,
};

module.exports = createCrudRouter(holidayYearsConfig);
