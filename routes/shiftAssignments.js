// routes/shiftAssignments.js
const createCrudRouter = require('../createCrudRouter');

const shiftAssignmentsConfig = {
  table: 'shiftly_schema.shift_assignments',
  idColumn: 'id',
  columns: [
    'shift_period_id',
    'shift_date',
    'department_id',
    'user_id',
    'staff_type_id',
    'shift_type_id',
    'source_type',
    'status',
    'status_comment',
	 'is_absence',
     'absence_type',
    'created_at',
    'updated_at',
	'staff_shift_rule_id',
    'required_staff_snapshot',
  ],
};

module.exports = createCrudRouter(shiftAssignmentsConfig);
