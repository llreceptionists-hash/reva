'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const db      = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

// Health check (before routes so it works even before full init)
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'Reva', ts: new Date().toISOString() }));

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  // 1. Initialise SQLite (sql.js is async at startup)
  await db.init();
  console.log('[DB] Initialised');

  // 2. Register routes (after DB is ready)
  const twilioRoutes    = require('./routes/twilio');
  const dashboardRoutes = require('./routes/dashboard');
  const { startScheduler } = require('./services/scheduler');

  app.use('/twilio', twilioRoutes);
  app.use('/api',    dashboardRoutes);
  app.get('*', (_, res) =>
    res.sendFile(path.join(__dirname, '../public/index.html'))
  );

  // 3. Start server
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           REVA — AI Roofing Receptionist        ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}                 ║
║  Dashboard: http://localhost:${PORT}                 ║
╚══════════════════════════════════════════════════╝
    `);

    // Warn on missing env vars
    const required = ['ANTHROPIC_API_KEY','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_PHONE_NUMBER'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length) {
      console.warn('⚠️  Missing env vars:', missing.join(', '));
      console.warn('   Copy .env.example → .env and fill in credentials.\n');
    }

    startScheduler();
  });
}

boot().catch(err => {
  console.error('Failed to start Reva:', err);
  process.exit(1);
});

module.exports = app;
