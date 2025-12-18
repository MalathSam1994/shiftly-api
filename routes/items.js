// routes/items.js
const express = require('express');
const pool = require('../db');

const router = express.Router();

// Existing items route (simple example)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM items ORDER BY id'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error querying DB (ITEMS LIST):', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
