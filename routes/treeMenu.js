// routes/treeMenu.js
// GET is user-filtered via DB function fn_tree_menu_for_user(user_id)
// Admin CRUD can be added later behind a stricter permission.

const express = require('express');
const pool = require('../db');
const requirePermission = require('../middleware/requirePermission');

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


// =========================================================
// ADMIN endpoints (full tree, add/edit, move/reorder)
// Guarded by permission: action:tree_menu:manage
// =========================================================
const ADMIN_PERM = 'action:tree_menu:manage';

// GET /tree-menu/admin/all -> full tree (includes sort_order + keys)
router.get('/admin/all', requirePermission(ADMIN_PERM), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        screen_id, parent_id, screen_type, screen_file_name, menu_label,
        screen_key, open_permission_key, sort_order
      FROM shiftly_schema.tree_menu
      ORDER BY parent_id NULLS FIRST, sort_order, screen_id
    `);
    res.json(rows);
  } catch (e) {
    console.error('TREE MENU ADMIN/all error:', e);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /tree-menu/admin -> create MENU or SCREEN
router.post('/admin', requirePermission(ADMIN_PERM), async (req, res) => {
  const {
    parent_id,
    screen_type,          // 'MENU' | 'SCREEN'
    menu_label,
    screen_file_name,     // for SCREEN
    screen_key,           // stable key for SCREEN (recommended)
    open_permission_key,  // optional override
  } = req.body ?? {};

  try {
    const type = String(screen_type ?? '').toUpperCase();
    if (!['MENU', 'SCREEN'].includes(type)) {
      return res.status(400).json({ error: 'screen_type must be MENU or SCREEN' });
    }
    if (!menu_label || String(menu_label).trim() === '') {
      return res.status(400).json({ error: 'menu_label is required' });
    }
    if (type === 'SCREEN' && (!screen_file_name || String(screen_file_name).trim() === '')) {
      return res.status(400).json({ error: 'screen_file_name is required for SCREEN' });
    }

    // Put new item at end of its siblings (max(sort_order)+10)
    const { rows: maxRows } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS mx FROM shiftly_schema.tree_menu WHERE parent_id IS NOT DISTINCT FROM $1`,
      [parent_id ?? null]
    );
    const nextOrder = Number(maxRows?.[0]?.mx ?? 0) + 10;

    const { rows } = await pool.query(
      `INSERT INTO shiftly_schema.tree_menu
        (parent_id, screen_type, screen_file_name, menu_label, screen_key, open_permission_key, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING screen_id, parent_id, screen_type, screen_file_name, menu_label, screen_key, open_permission_key, sort_order`,
      [
        parent_id ?? null,
        type,
        type === 'SCREEN' ? screen_file_name : null,
        menu_label,
        type === 'SCREEN' ? (screen_key ?? null) : null,
        type === 'SCREEN' ? (open_permission_key ?? null) : null,
        nextOrder,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('TREE MENU ADMIN/create error:', e);
    res.status(500).json({ error: 'Database error', detail: String(e.message ?? e) });
  }
});

// PUT /tree-menu/admin/:id -> edit label/file (lock screen_key once set)
router.put('/admin/:id', requirePermission(ADMIN_PERM), async (req, res) => {
  const id = Number(req.params.id);
  const {
    menu_label,
    screen_file_name,
    screen_key,          // only allowed if currently NULL/empty
    open_permission_key, // only allowed if currently NULL/empty
  } = req.body ?? {};

  try {
    const { rows: curRows } = await pool.query(
      `SELECT screen_type, screen_key, open_permission_key
       FROM shiftly_schema.tree_menu WHERE screen_id=$1`,
      [id]
    );
    if (curRows.length === 0) return res.status(404).json({ error: 'Not found' });

    const cur = curRows[0];
    const type = String(cur.screen_type).toUpperCase();

    if (!menu_label || String(menu_label).trim() === '') {
      return res.status(400).json({ error: 'menu_label is required' });
    }
    if (type === 'SCREEN' && (!screen_file_name || String(screen_file_name).trim() === '')) {
      return res.status(400).json({ error: 'screen_file_name is required for SCREEN' });
    }

    // Lock screen_key & open_permission_key once set to avoid breaking RBAC mappings.
    const canSetKey = !cur.screen_key || String(cur.screen_key).trim() === '';
    const canSetOpen = !cur.open_permission_key || String(cur.open_permission_key).trim() === '';

    const newScreenKey = (type === 'SCREEN' && canSetKey) ? (screen_key ?? null) : cur.screen_key;
    const newOpenKey = (type === 'SCREEN' && canSetOpen) ? (open_permission_key ?? null) : cur.open_permission_key;

    const { rows } = await pool.query(
      `UPDATE shiftly_schema.tree_menu
       SET menu_label=$2,
           screen_file_name=$3,
           screen_key=$4,
           open_permission_key=$5
       WHERE screen_id=$1
       RETURNING screen_id, parent_id, screen_type, screen_file_name, menu_label, screen_key, open_permission_key, sort_order`,
      [id, menu_label, type === 'SCREEN' ? screen_file_name : null, newScreenKey, newOpenKey]
    );

    res.json(rows[0]);
  } catch (e) {
    console.error('TREE MENU ADMIN/update error:', e);
    res.status(500).json({ error: 'Database error', detail: String(e.message ?? e) });
  }
});

// PATCH /tree-menu/admin/:id/move -> move between parents and/or reorder among siblings
// body: { new_parent_id: int|null, new_index: int }
router.patch('/admin/:id/move', requirePermission(ADMIN_PERM), async (req, res) => {
  const id = Number(req.params.id);
  const newParentId = (req.body?.new_parent_id ?? null);
  const newIndex = Number(req.body?.new_index ?? 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load current
    const { rows: curRows } = await client.query(
      `SELECT screen_id, parent_id, sort_order
       FROM shiftly_schema.tree_menu
       WHERE screen_id=$1
       FOR UPDATE`,
      [id]
    );
    if (curRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const cur = curRows[0];

    // Fetch old siblings (excluding moving node)
    const { rows: oldSiblings } = await client.query(
      `SELECT screen_id
       FROM shiftly_schema.tree_menu
       WHERE parent_id IS NOT DISTINCT FROM $1
         AND screen_id <> $2
       ORDER BY sort_order, screen_id
       FOR UPDATE`,
      [cur.parent_id, id]
    );

    // Fetch new siblings (excluding moving node)
    const { rows: newSiblings } = await client.query(
      `SELECT screen_id
       FROM shiftly_schema.tree_menu
       WHERE parent_id IS NOT DISTINCT FROM $1
         AND screen_id <> $2
       ORDER BY sort_order, screen_id
       FOR UPDATE`,
      [newParentId, id]
    );

    // Insert at newIndex (clamped)
    const list = newSiblings.map(r => r.screen_id);
    const idx = Math.max(0, Math.min(newIndex, list.length));
    list.splice(idx, 0, id);

    // Re-number new siblings
    for (let i = 0; i < list.length; i++) {
      await client.query(
        `UPDATE shiftly_schema.tree_menu SET parent_id=$2, sort_order=$3 WHERE screen_id=$1`,
        [list[i], newParentId, (i + 1) * 10]
      );
    }

    // Re-number old siblings (only if parent changed)
    const parentChanged =
      (cur.parent_id ?? null) !== (newParentId ?? null) &&
      !(cur.parent_id == null && newParentId == null);

    if (parentChanged) {
      for (let i = 0; i < oldSiblings.length; i++) {
        await client.query(
          `UPDATE shiftly_schema.tree_menu SET sort_order=$2 WHERE screen_id=$1`,
          [oldSiblings[i].screen_id, (i + 1) * 10]
        );
      }
    }

    await client.query('COMMIT');

    const { rows: outRows } = await pool.query(
      `SELECT screen_id, parent_id, screen_type, screen_file_name, menu_label, screen_key, open_permission_key, sort_order
       FROM shiftly_schema.tree_menu
       WHERE screen_id=$1`,
      [id]
    );
    res.json(outRows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('TREE MENU ADMIN/move error:', e);
    res.status(500).json({ error: 'Database error', detail: String(e.message ?? e) });
  } finally {
    client.release();
  }
});


module.exports = router;

