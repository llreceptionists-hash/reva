'use strict';

const express = require('express');
const router  = express.Router();
const { leads: leadsDb, conversations, followUps, clients } = require('../db/leads');
const { sendSms } = require('../services/sms');
const db = require('../db/database');

router.use((req, res, next) => next());

// GET /api/debug
router.get('/debug', async (req, res) => {
  const db = require('../db/database');
  const count = await db.scalar('SELECT COUNT(*) FROM leads');
  const rows = await db.all('SELECT id, phone, stage, updated_at FROM leads LIMIT 10');
  res.json({ count, rows });
});

// GET /api/stats
router.get('/stats', async (req, res) => {
  res.json(await leadsDb.stats());
});

// GET /api/leads
router.get('/leads', async (req, res) => {
  const { stage, priority, limit = 50, offset = 0 } = req.query;
  res.json(await leadsDb.list({ stage, priority, limit: +limit, offset: +offset }));
});

// GET /api/leads/:phone
router.get('/leads/:phone', async (req, res) => {
  const lead = await leadsDb.findByPhone(req.params.phone);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const history = await conversations.getForPhone(req.params.phone);
  res.json({ lead, history });
});

// PATCH /api/leads/:phone
router.patch('/leads/:phone', async (req, res) => {
  const allowed = ['name','email','address','stage','priority','assigned_to','notes',
                   'issue_type','urgency','preferred_appointment','property_type'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const lead = await leadsDb.update(req.params.phone, updates);
  res.json(lead);
});

// POST /api/leads/:phone/sms
router.post('/leads/:phone/sms', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    await sendSms(req.params.phone, message);
    const lead = await leadsDb.findByPhone(req.params.phone);
    await conversations.add(req.params.phone, 'sms', 'outbound', message, lead?.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/follow-ups/pending
router.get('/follow-ups/pending', async (req, res) => {
  res.json(await followUps.getPending());
});

// GET /api/pipeline
router.get('/pipeline', async (req, res) => {
  const stages = ['new','contacted','qualified','appointment_set','won','lost'];
  const pipeline = {};
  for (const s of stages) {
    const row = await db.get("SELECT COUNT(*) as count FROM leads WHERE stage = $1", [s]);
    pipeline[s] = row ? parseInt(row.count) : 0;
  }
  res.json(pipeline);
});

// GET /api/conversations/:phone
router.get('/conversations/:phone', async (req, res) => {
  res.json(await conversations.getForPhone(req.params.phone, 100));
});

// DELETE /api/leads/:phone/follow-ups
router.delete('/leads/:phone/follow-ups', async (req, res) => {
  await followUps.cancelForPhone(req.params.phone);
  res.json({ ok: true });
});

// DELETE /api/leads/:phone — wipe a lead and all its conversations/follow-ups
router.delete('/leads/:phone', async (req, res) => {
  const phone = req.params.phone;
  try {
    await followUps.cancelForPhone(phone);
    await db.run('DELETE FROM conversations WHERE phone = ?', [phone]);
    await db.run('DELETE FROM leads WHERE phone = ?', [phone]);
    res.json({ ok: true, deleted: phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Clients ────────────────────────────────────────────────────────────────────

// GET /api/clients
router.get('/clients', async (req, res) => {
  res.json(await clients.list());
});

// POST /api/clients
router.post('/clients', async (req, res) => {
  const { phone_number, company_name, owner_phone, booking_url, forward_phone, voice, address } = req.body;
  if (!phone_number || !company_name) return res.status(400).json({ error: 'phone_number and company_name required' });
  try {
    const client = await clients.create({ phone_number, company_name, owner_phone, booking_url, forward_phone, voice, address });
    res.json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/clients/:id
router.patch('/clients/:id', async (req, res) => {
  const updated = await clients.update(req.params.id, req.body);
  res.json(updated || { ok: true });
});

// DELETE /api/clients/:id
router.delete('/clients/:id', async (req, res) => {
  await clients.delete(req.params.id);
  res.json({ ok: true });
});

// POST /api/demo-request — landing page form submission
router.post('/demo-request', async (req, res) => {
  const { name, company, owner_phone, booking_url } = req.body;
  try {
    const { alertOwner } = require('../services/sms');
    await alertOwner(
      `🚀 NEW CLIENT SIGNUP!\n` +
      `👤 Name: ${name || 'Unknown'}\n` +
      `🏢 Company: ${company || 'Unknown'}\n` +
      `📞 Phone: ${owner_phone || 'Not given'}\n` +
      `🔗 Booking link: ${booking_url || 'None'}`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[DEMO] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/web-inquiry — website quote form submission
router.post('/leads/web-inquiry', async (req, res) => {
  const { name, phone, address, service, property_type, notes, client } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const { alertOwner } = require('../services/sms');

    // Find which client this form belongs to
    let clientRecord = null;
    if (client) {
      const allClients = await clients.list();
      clientRecord = allClients.find(c =>
        c.company_name.toLowerCase().replace(/\s+/g, '') === client.toLowerCase().replace(/\s+/g, '')
      );
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const e164 = cleanPhone.startsWith('1') ? `+${cleanPhone}` : `+1${cleanPhone}`;

    // Create or update lead
    const lead = await leadsDb.create(e164, 'website', clientRecord?.phone_number || null);
    await leadsDb.update(e164, {
      name:           name || null,
      address:        address || null,
      issue_type:     service || null,
      property_type:  property_type?.toLowerCase().includes('commercial') ? 'commercial' : 'residential',
      notes:          notes || null,
      stage:          'new',
    });

    // Alert the business owner
    const ownerPhone = clientRecord?.owner_phone || process.env.OWNER_PHONE;
    if (ownerPhone) {
      await alertOwner(
        `🌐 NEW WEB INQUIRY!\n` +
        `👤 Name: ${name || 'Unknown'}\n` +
        `📞 Phone: ${e164}\n` +
        `🏠 Service: ${service || 'Not specified'}\n` +
        `📍 Address: ${address || 'Not given'}\n` +
        `📝 Notes: ${notes || 'None'}`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB-INQUIRY] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
