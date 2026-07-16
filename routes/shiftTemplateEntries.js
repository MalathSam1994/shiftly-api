// routes/shiftTemplateEntries.js
const express = require('express');
const pool = require('../db');
const createCrudRouter = require('../createCrudRouter');
const { parseOptionalBoolean } = require('../utils/activeStatus');





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

const router = createCrudRouter(shiftTemplateEntriesConfig);

// POST /shift-template-entries/copy-pattern
// Body:
// {
//   "template_id": 1,
//   "src_day_of_week": 1,
//   "src_week_of_cycle": 1,
//   "dst_day_of_week": 4,
//   "dst_week_of_cycle": 1,
//   "replace": true
// }
router.post('/copy-pattern', async (req, res) => {
  try {
    const {
      template_id,
      src_day_of_week,
      src_week_of_cycle,
      dst_day_of_week,
      dst_week_of_cycle,
      replace,
    } = req.body || {};

    if (
      template_id == null ||
      src_day_of_week == null ||
      src_week_of_cycle == null ||
      dst_day_of_week == null ||
      dst_week_of_cycle == null
    ) {
      return res.status(400).json({
        error:
          'Missing required fields: template_id, src_day_of_week, src_week_of_cycle, dst_day_of_week, dst_week_of_cycle',
      });
    }

    const parsedReplace = parseOptionalBoolean(replace, 'replace');
    const replaceFlag = parsedReplace === undefined ? true : parsedReplace;

    const templateCheck = await pool.query(
      `SELECT id, is_active
       FROM shiftly_schema.shift_templates
       WHERE id = $1`,
      [template_id]
    );

    if (templateCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Shift template not found.' });
    }

    if (templateCheck.rows[0].is_active === false) {
      return res.status(400).json({
        error: 'Cannot copy entries from an inactive shift template.',
      });
    }

    const sql = `
      SELECT inserted_count, deleted_count
      FROM shiftly_schema.copy_shift_template_day_pattern($1,$2,$3,$4,$5,$6)
    `;

    const r = await pool.query(sql, [
      template_id,
      src_day_of_week,
      src_week_of_cycle,
      dst_day_of_week,
      dst_week_of_cycle,
      replaceFlag,
    ]);

    return res.status(200).json(r.rows[0] || { inserted_count: 0, deleted_count: 0 });
  } catch (e) {
    console.error('copy-pattern failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;

