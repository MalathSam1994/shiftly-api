// routes/treeMenu.js
const createCrudRouter = require('../createCrudRouter');

const treeMenuConfig = {
  table: 'shiftly_schema.tree_menu',
  idColumn: 'screen_id',
  columns: ['parent_id', 'screen_type', 'screen_file_name', 'menu_label'],
};

module.exports = createCrudRouter(treeMenuConfig);
