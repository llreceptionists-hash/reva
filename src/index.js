'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const path    = require('path');
const { WebSocketServer } = require('ws');
const db      = require('./db/database');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'Reva', ts: new Date().toISOString() }));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await db.init();
  console.log('[DB] Initialised');

  const twilioRoutes          = require('./routes/twilio');
  const dashboardRoutes       = require('./routes/dashboard');
  const { startScheduler }    = require('./services/scheduler');
  const { createRealtimeBridge } = require('./services/realtime-voice');
  const { clients }           = require('./db/leads');

  app.use('/twilio', twilioRoutes);
  app.use('/api',    dashboardRoutes);
  app.get('*', (_, res) =>
    res.sendFile(path.join(__dirname, '../public/index.html'))
  );

  // ── WebSocket server for Twilio Media Streams ─────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/twilio/voice/stream')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const params      = new URLSearchParams(req.url.split('?')[1] || '');
      const phone       = params.get('phone') || 'unknown';
      const clientPhone = params.get('client') || '';

      let revaClient;
      try {
        revaClient = clientPhone ? await clients.findByPhone(clientPhone) : null;
        if (!revaClient) revaClient = clients.getDefault();
      } catch {
        revaClient = clients.getDefault();
      }

      console.log(`[WS] Stream connection: ${phone} → ${revaClient.company_name}`);
      createRealtimeBridge(ws, phone, revaClient);
    });
  });

  // ── Start server ───────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           REVA — AI Roofing Receptionist        ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}                 ║
║  Dashboard: http://localhost:${PORT}                 ║
╚══════════════════════════════════════════════════╝
    `);

    const required = [
      'ANTHROPIC_API_KEY','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN',
      'TWILIO_PHONE_NUMBER','OPENAI_API_KEY',
    ];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      console.warn('⚠️  Missing env vars:', missing.join(', '));
    }

    startScheduler();
  });
}

boot().catch(err => {
  console.error('Failed to start Reva:', err.message);
  console.error(err.stack);
  process.exit(1);
});

module.exports = app;
