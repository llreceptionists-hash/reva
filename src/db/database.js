'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      phone_number TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      owner_phone TEXT,
      booking_url TEXT,
      forward_phone TEXT,
      voice TEXT DEFAULT 'Polly.Joanna-Neural',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      client_phone TEXT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT, email TEXT, address TEXT, city TEXT,
      property_type TEXT, issue_type TEXT, urgency TEXT,
      roof_size TEXT, has_other_quotes INTEGER DEFAULT 0,
      timeline TEXT, budget_range TEXT, preferred_appointment TEXT,
      notes TEXT, stage TEXT DEFAULT 'new',
      priority TEXT DEFAULT 'normal', assigned_to TEXT,
      source TEXT DEFAULT 'inbound',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_contact_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER, phone TEXT NOT NULL, channel TEXT NOT NULL,
      direction TEXT NOT NULL, message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER, phone TEXT NOT NULL, message TEXT NOT NULL,
      scheduled_at TIMESTAMP NOT NULL, sent_at TIMESTAMP,
      status TEXT DEFAULT 'pending', trigger_type TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_sessions (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      messages TEXT NOT NULL DEFAULT '[]',
      stage TEXT DEFAULT 'greeting',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('[DB] PostgreSQL connected and schema ready');
}

async function run(sql, params = []) {
  // Convert SQLite ? placeholders to PostgreSQL $1, $2, ...
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  await pool.query(pgSql, params);
}

async function all(sql, params = []) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const result = await pool.query(pgSql, params);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

async function scalar(sql, params = []) {
  const row = await get(sql, params);
  return row ? Object.values(row)[0] : null;
}

module.exports = { init, run, all, get, scalar };
