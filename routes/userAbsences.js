// Path: d:\Cloned_REPOS\shiftly-api\routes\userAbsences.js
// (adjust base folder name if your API repo path is different)

const createCrudRouter = require('../createCrudRouter');

const userAbsencesConfig = {
  table: 'shiftly_schema.user_absences',
  idColumn: 'id',
  columns: [
    'user_id',
    'absence_type',
    'start_date',
    'end_date',
    'created_by',
    'comment',
  ],
};

module.exports = createCrudRouter(userAbsencesConfig);

