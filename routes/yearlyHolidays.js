const express = require('express');
const pool = require('../db');
const router = express.Router();



// Run a single query with a per-request statement_timeout that does NOT leak to pooled sessions.
async function queryWithTimeout(sql, params = [], timeoutMs = 20000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// GET /yearly-holidays?holiday_year_id=123
router.get('/', async (req, res) => {
  try {
    const holidayYearIdRaw = req.query.holiday_year_id;
    if (!holidayYearIdRaw) {
      return res.status(400).json({ error: 'holiday_year_id query parameter is required' });
    }

    const holidayYearId = Number(holidayYearIdRaw);
    if (!Number.isInteger(holidayYearId) || holidayYearId <= 0) {
      return res.status(400).json({ error: 'holiday_year_id must be a positive integer' });
    }

    const sql = `
      SELECT id, holiday_year_id, holiday_date, occasion, created_by, created_at
      FROM shiftly_schema.yearly_holidays
      WHERE holiday_year_id = $1
      ORDER BY holiday_date
    `;

    const result = await queryWithTimeout(sql, [holidayYearId], 20000);
    return res.json(result.rows);
  } catch (err) {
    console.error('Error querying DB (YEARLY HOLIDAYS LIST):', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// GET /yearly-holidays/:id
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    const sql = `
      SELECT id, holiday_year_id, holiday_date, occasion, created_by, created_at
      FROM shiftly_schema.yearly_holidays
      WHERE id = $1
    `;

    const result = await queryWithTimeout(sql, [id], 20000);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error querying DB (YEARLY HOLIDAYS GET BY ID):', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// POST /yearly-holidays
// body: { holiday_year_id: 1, holiday_date: "2026-12-25", occasion: "Christmas", created_by: 7 }
router.post('/', async (req, res) => {
  try {
    const holidayYearId = Number(req.body.holiday_year_id);
    const holidayDate = req.body.holiday_date;
    const occasion = req.body.occasion;
    const createdBy = Number(req.body.created_by);

    if (!Number.isInteger(holidayYearId) || holidayYearId <= 0) {
      return res.status(400).json({ error: 'holiday_year_id must be a positive integer' });
    }
    if (typeof holidayDate !== 'string' || holidayDate.trim().length === 0) {
      return res.status(400).json({ error: 'holiday_date must be a non-empty string (YYYY-MM-DD)' });
    }
    if (typeof occasion !== 'string' || occasion.trim().length === 0) {
      return res.status(400).json({ error: 'occasion must be a non-empty string' });
    }

    if (!Number.isInteger(createdBy) || createdBy <= 0) {
    return res.status(400).json({ error: 'created_by must be a positive integer' });
    }

    const sql = `
      INSERT INTO shiftly_schema.yearly_holidays
        (holiday_year_id, holiday_date, occasion, created_by)
      VALUES
        ($1, $2::date, $3, $4)
      RETURNING id, holiday_year_id, holiday_date, occasion, created_by, created_at
    `;

    const result = await queryWithTimeout(
      sql,
      [holidayYearId, holidayDate.trim(), occasion.trim(), createdBy],
      20000
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error inserting into DB (YEARLY HOLIDAYS CREATE):', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// PUT /yearly-holidays/:id
// body: { holiday_date: "2026-12-26", occasion: "Holiday" }
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    const holidayDate = req.body.holiday_date;
    const occasion = req.body.occasion;

    const sets = [];
    const values = [];
    let i = 1;

    if (typeof holidayDate === 'string' && holidayDate.trim().length > 0) {
      sets.push(`holiday_date = $${i}::date`);
      values.push(holidayDate.trim());
      i++;
    }

    if (typeof occasion === 'string' && occasion.trim().length > 0) {
      sets.push(`occasion = $${i}`);
      values.push(occasion.trim());
      i++;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No valid columns provided for update' });
    }

    values.push(id);

    const sql = `
      UPDATE shiftly_schema.yearly_holidays
      SET ${sets.join(', ')}
      WHERE id = $${i}
      RETURNING id, holiday_year_id, holiday_date, occasion, created_by, created_at
    `;

    const result = await queryWithTimeout(sql, values, 20000);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating DB (YEARLY HOLIDAYS UPDATE):', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /yearly-holidays/:id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    const sql = `
      DELETE FROM shiftly_schema.yearly_holidays
      WHERE id = $1
      RETURNING id, holiday_year_id, holiday_date, occasion, created_by, created_at
    `;

    const result = await queryWithTimeout(sql, [id], 20000);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting from DB (YEARLY HOLIDAYS DELETE):', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
