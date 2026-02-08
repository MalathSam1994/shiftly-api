// routes/treeMenu.js
// GET is user-filtered via DB function fn_tree_menu_for_user(user_id)
// Admin CRUD can be added later behind a stricter permission.

const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /tree-menu -> only allowed entries for current user
router.get('/', async (req, res) => {
  try {
    const userId = Number(req.user?.sub ?? req.user?.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sql = `SELECT * FROM shiftly_api.fn_tree_menu_for_user($1)`;
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (e) {
    console.error('TREE MENU error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;

