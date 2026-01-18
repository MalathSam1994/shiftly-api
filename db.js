// db.js
const { Pool } = require('pg');
require('dotenv').config(); // ensures env vars are loaded if used directly

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,

  // add these:
  max: 20,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 30000,
});


// 🔎 PG pool health monitoring (global)
setInterval(() => {
  console.log('PG POOL', {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
}, 5000);


module.exports = pool;
