'use strict';

const db = require('./database');

// ── Leads ────────────────────────────────────────────────────────────────────
const leads = {
  async findByPhone(phone) {
    return db.get('SELECT * FROM leads WHERE phone = ?', [phone]);
  },

  async create(phone, source = 'inbound', clientPhone = null) {
    await db.run(`
      INSERT INTO leads (phone, client_phone, source, stage, created_at, updated_at)
      VALUES (?, ?, ?, 'new', NOW(), NOW())
      ON CONFLICT(phone) DO UPDATE SET updated_at = NOW()
    `, [phone, clientPhone, source]);
    return this.findByPhone(phone);
  },

  async update(phone, fields) {
    const allowed = [
      'name','email','address','city','property_type','issue_type','urgency',
      'roof_size','has_other_quotes','timeline','budget_range','preferred_appointment',
      'notes','stage','priority','assigned_to','last_contact_at','client_phone'
    ];
    const pairs = Object.entries(fields).filter(([k]) => allowed.includes(k));
    if (!pairs.length) return this.findByPhone(phone);
    const setClauses = pairs.map(([k]) => `${k} = ?`).join(', ');
    const values = pairs.map(([, v]) => v);
    await db.run(
      `UPDATE leads SET ${setClauses}, updated_at = NOW() WHERE phone = ?`,
      [...values, phone]
    );
    return this.findByPhone(phone);
  },

  async list({ stage, priority, clientPhone, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM leads WHERE 1=1';
    const params = [];
    if (stage)       { sql += ` AND stage = ?`;        params.push(stage); }
    if (priority)    { sql += ` AND priority = ?`;     params.push(priority); }
    if (clientPhone) { sql += ` AND client_phone = ?`; params.push(clientPhone); }
    sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return db.all(sql, params);
  },

  async stats(clientPhone = null) {
    const w = clientPhone ? `AND client_phone = '${clientPhone}'` : '';
    return {
      total:           (await db.scalar(`SELECT COUNT(*) FROM leads WHERE 1=1 ${w}`)) || 0,
      new:             (await db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'new' ${w}`)) || 0,
      qualified:       (await db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'qualified' ${w}`)) || 0,
      appointment_set: (await db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'appointment_set' ${w}`)) || 0,
      won:             (await db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'won' ${w}`)) || 0,
      today:           (await db.scalar(`SELECT COUNT(*) FROM leads WHERE date(created_at) = CURRENT_DATE ${w}`)) || 0,
    };
  }
};

// ── Conversations ─────────────────────────────────────────────────────────────
const conversations = {
  async add(phone, channel, direction, message, leadId = null) {
    await db.run(
      'INSERT INTO conversations (lead_id, phone, channel, direction, message) VALUES (?,?,?,?,?)',
      [leadId, phone, channel, direction, message]
    );
  },

  async getForPhone(phone, limit = 200) {
    return db.all(
      'SELECT * FROM conversations WHERE phone = ? ORDER BY created_at ASC LIMIT ?',
      [phone, limit]
    );
  }
};

// ── Follow-ups ────────────────────────────────────────────────────────────────
const followUps = {
  async schedule(phone, message, scheduledAt, triggerType, leadId = null) {
    await db.run(
      'INSERT INTO follow_ups (lead_id, phone, message, scheduled_at, trigger_type) VALUES (?,?,?,?,?)',
      [leadId, phone, message, scheduledAt, triggerType]
    );
  },

  async getPending() {
    return db.all(`
      SELECT * FROM follow_ups
      WHERE status = 'pending' AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC
    `);
  },

  async markSent(id) {
    await db.run(
      "UPDATE follow_ups SET status = 'sent', sent_at = NOW() WHERE id = ?",
      [id]
    );
  },

  async cancelForPhone(phone) {
    await db.run(
      "UPDATE follow_ups SET status = 'cancelled' WHERE phone = ? AND status = 'pending'",
      [phone]
    );
  }
};

// ── AI Sessions ───────────────────────────────────────────────────────────────
const aiSessions = {
  async get(phone) {
    const row = await db.get('SELECT * FROM ai_sessions WHERE phone = ?', [phone]);
    if (!row) return null;
    return { ...row, messages: JSON.parse(row.messages) };
  },

  async upsert(phone, messages, stage) {
    await db.run(`
      INSERT INTO ai_sessions (phone, messages, stage, updated_at)
      VALUES (?, ?, ?, NOW())
      ON CONFLICT(phone) DO UPDATE SET
        messages = EXCLUDED.messages,
        stage = EXCLUDED.stage,
        updated_at = NOW()
    `, [phone, JSON.stringify(messages), stage]);
  },

  async clear(phone) {
    await db.run('DELETE FROM ai_sessions WHERE phone = ?', [phone]);
  }
};

// ── Clients ───────────────────────────────────────────────────────────────────
const clients = {
  async findByPhone(phoneNumber) {
    return db.get('SELECT * FROM clients WHERE phone_number = ?', [phoneNumber]);
  },

  async list() {
    return db.all('SELECT * FROM clients ORDER BY created_at DESC');
  },

  async create(data) {
    const existing = await this.findByPhone(data.phone_number);
    if (existing) throw new Error(`A client with number ${data.phone_number} already exists.`);
    await db.run(
      `INSERT INTO clients (phone_number, company_name, owner_phone, booking_url, forward_phone, voice)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.phone_number, data.company_name, data.owner_phone || null,
       data.booking_url || null, data.forward_phone || null,
       data.voice || 'Polly.Joanna-Neural']
    );
    return this.findByPhone(data.phone_number);
  },

  async update(id, data) {
    const allowed = ['company_name','owner_phone','booking_url','forward_phone','voice','active'];
    const pairs = Object.entries(data).filter(([k]) => allowed.includes(k));
    if (!pairs.length) return;
    const setClauses = pairs.map(([k]) => `${k} = ?`).join(', ');
    const values = pairs.map(([, v]) => v);
    await db.run(`UPDATE clients SET ${setClauses} WHERE id = ?`, [...values, id]);
    return db.get('SELECT * FROM clients WHERE id = ?', [id]);
  },

  async delete(id) {
    await db.run('DELETE FROM clients WHERE id = ?', [id]);
  },

  getDefault() {
    return {
      phone_number:  process.env.TWILIO_PHONE_NUMBER || '',
      company_name:  process.env.COMPANY_NAME || 'Reva Roofing',
      owner_phone:   process.env.OWNER_PHONE || '',
      booking_url:   process.env.BOOKING_URL || '',
      forward_phone: process.env.FORWARD_PHONE || '',
      voice:         process.env.TWILIO_VOICE || 'Polly.Joanna-Neural',
    };
  }
};

module.exports = { leads, conversations, followUps, aiSessions, clients };
