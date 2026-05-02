'use strict';

/**
 * SQLite wrapper using sql.js (pure WebAssembly — no native compilation needed).
 * We load the DB from disk at startup and flush to disk after every write.
 */

const path = require('path');
const fs   = require('fs');

const DB_PATH  = path.join(__dirname, '../../data/reva.db');
const DATA_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let _db  = null;   // sql.js Database instance
let _SQL = null;   // sql.js constructor

// ── Initialise (called once at startup) ─────────────────────────────────────
async function init() {
  if (_db) return _db;
  const initSqlJs = require('sql.js');
  _SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new _SQL.Database(buf);
  } else {
    _db = new _SQL.Database();
  }

  // Create schema
  _db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      owner_phone TEXT,
      booking_url TEXT,
      forward_phone TEXT,
      voice TEXT DEFAULT 'Polly.Joanna-Neural',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone TEXT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT, email TEXT, address TEXT, city TEXT,
      property_type TEXT, issue_type TEXT, urgency TEXT,
      roof_size TEXT, has_other_quotes INTEGER DEFAULT 0,
      timeline TEXT, budget_range TEXT, preferred_appointment TEXT,
      notes TEXT, stage TEXT DEFAULT 'new',
      priority TEXT DEFAULT 'normal', assigned_to TEXT,
      source TEXT DEFAULT 'inbound',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_contact_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER, phone TEXT NOT NULL, channel TEXT NOT NULL,
      direction TEXT NOT NULL, message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER, phone TEXT NOT NULL, message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, sent_at TEXT,
      status TEXT DEFAULT 'pending', trigger_type TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      messages TEXT NOT NULL DEFAULT '[]',
      stage TEXT DEFAULT 'greeting',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add client_phone to existing leads table if missing
  try { _db.run(`ALTER TABLE leads ADD COLUMN client_phone TEXT`); } catch (_) {}

  flush();
  return _db;
}

/** Save DB to disk after every write. */
function flush() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[DB] Flush error:', e.message);
  }
}

// ── Low-level helpers ────────────────────────────────────────────────────────

/** Run a write statement (INSERT / UPDATE / DELETE / CREATE). */
function run(sql, params = []) {
  if (!_db) throw new Error('DB not initialised — call await db.init() first');
  _db.run(sql, params);
  flush();
}

/** Return all matching rows as plain objects. */
function all(sql, params = []) {
  if (!_db) throw new Error('DB not initialised');
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** Return first matching row or undefined. */
function get(sql, params = []) {
  return all(sql, params)[0];
}

/** Return a single scalar value from the first column of the first row. */
function scalar(sql, params = []) {
  const row = get(sql, params);
  return row ? Object.values(row)[0] : null;
}

module.exports = { init, run, all, get, scalar, flush };
