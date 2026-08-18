'use strict';

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Create a free Postgres database (e.g. at neon.tech), ' +
      'then set DATABASE_URL="postgres://..." in your environment (.env locally, ' +
      'or the Render dashboard in production) and restart.'
    );
  }
  pool = new Pool({
    connectionString: connectionString,
    ssl: connectionString.indexOf('localhost') === -1 ? { rejectUnauthorized: false } : false,
    max: 10,
  });
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
