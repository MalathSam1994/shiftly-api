const createCrudRouter = require('../createCrudRouter');

const holidayYearsConfig = {
  table: 'shiftly_schema.holiday_years',
  idColumn: 'id',
  columns: ['year'],
};

module.exports = createCrudRouter(holidayYearsConfig);
