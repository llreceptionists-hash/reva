'use strict';

const express = require('express');
const router  = express.Router();
const { leads: leadsDb, conversations, followUps, clients } = require('../db/leads');
const { sendSms }    = require('../services/sms');
const db = require('../db/database');

router.use((req, res, next) => next());

// GET /api/stats
router.get('/stats', (req, res) => {
  res.json(leadsDb.stats());
});

// GET /api/leads
router.get('/leads', (req, res) => {
  const { stage, priority, limit = 50, offset = 0 } = req.query;
  res.json(leadsDb.list({ stage, priority, limit: +limit, offset: +offset }));
});

// GET /api/leads/:phone
router.get('/leads/:phone', (req, res) => {
  const lead = leadsDb.findByPhone(req.params.phone);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const history = conversations.getForPhone(req.params.phone, 50);
  res.json({ lead, history });
});

// PATCH /api/leads/:phone  — update stage, assigned_to, notes, etc.
router.patch('/leads/:phone', (req, res) => {
  const allowed = ['name','email','address','stage','priority','assigned_to','notes',
                   'issue_type','urgency','preferred_appointment','property_type'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const lead = leadsDb.update(req.params.phone, updates);
  res.json(lead);
});

// POST /api/leads/:phone/sms  — send manual SMS to a lead
router.post('/leads/:phone/sms', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    await sendSms(req.params.phone, message);
    const lead = leadsDb.findByPhone(req.params.phone);
    conversations.add(req.params.phone, 'sms', 'outbound', message, lead?.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/follow-ups/pending
router.get('/follow-ups/pending', (req, res) => {
  res.json(followUps.getPending());
});

// GET /api/pipeline  — kanban-style counts per stage
router.get('/pipeline', (req, res) => {
  const stages = ['new','contacted','qualified','appointment_set','won','lost'];
  const pipeline = {};
  for (const s of stages) {
    const row = db.get("SELECT COUNT(*) as count FROM leads WHERE stage = ?", [s]);
    pipeline[s] = row ? row.count : 0;
  }
  res.json(pipeline);
});

// GET /api/conversations/:phone
router.get('/conversations/:phone', (req, res) => {
  res.json(conversations.getForPhone(req.params.phone, 100));
});

// DELETE /api/leads/:phone/follow-ups  — cancel scheduled follow-ups
router.delete('/leads/:phone/follow-ups', (req, res) => {
  followUps.cancelForPhone(req.params.phone);
  res.json({ ok: true });
});

// ── Clients ────────────────────────────────────────────────────────────────────

// GET /api/clients
router.get('/clients', (req, res) => {
  res.json(clients.list());
});

// POST /api/clients
router.post('/clients', (req, res) => {
  const { phone_number, company_name, owner_phone, booking_url, forward_phone, voice } = req.body;
  if (!phone_number || !company_name) return res.status(400).json({ error: 'phone_number and company_name required' });
  try {
    const client = clients.create({ phone_number, company_name, owner_phone, booking_url, forward_phone, voice });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id
router.patch('/clients/:id', (req, res) => {
  const updated = clients.update(req.params.id, req.body);
  res.json(updated || { ok: true });
});

// DELETE /api/clients/:id
router.delete('/clients/:id', (req, res) => {
  clients.delete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
