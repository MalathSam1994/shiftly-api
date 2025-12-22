const createCrudRouter = require('../createCrudRouter');

const divisionsConfig = {
  table: 'shiftly_schema.divisions',
  idColumn: 'id',
  columns: ['division_desc'],
};

module.exports = createCrudRouter(divisionsConfig);
