const createCrudRouter = require('../createCrudRouter');

const userDivisionsConfig = {
  table: 'shiftly_schema.user_divisions',
  idColumn: 'id',
  columns: ['user_id', 'division_id', 'division_desc'],
};

module.exports = createCrudRouter(userDivisionsConfig);
