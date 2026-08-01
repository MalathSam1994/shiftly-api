function getBusinessTimezone() {
  const candidates = [
    process.env.SHIFTLY_BUSINESS_TIMEZONE,
    process.env.BUSINESS_TIMEZONE,
    process.env.TZ,
  ];

  for (const value of candidates) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
  }

  return '';
}

async function setLocalBusinessTimezone(client) {
  const timezone = getBusinessTimezone();
  if (!timezone) return null;

  await client.query(
    `SELECT set_config('shiftly.business_timezone', $1, true)`,
    [timezone],
  );

  return timezone;
}

async function runInTransactionWithBusinessTimezone(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setLocalBusinessTimezone(client);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getBusinessTimezone,
  runInTransactionWithBusinessTimezone,
  setLocalBusinessTimezone,
};
