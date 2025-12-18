// routes/shiftTemplates.js
const createCrudRouter = require('../createCrudRouter');

const shiftTemplatesConfig = {
  table: 'shiftly_schema.shift_templates',
  idColumn: 'id',
  columns: [
    'template_name',
    'pattern_type',
    'cycle_length_weeks',
    'cycle_anchor_date',
    'is_active',
    'description',
  ],
};

module.exports = createCrudRouter(shiftTemplatesConfig);
