'use strict';

const db = require('./database');

// ── Leads ────────────────────────────────────────────────────────────────────
const leads = {
  findByPhone(phone) {
    return db.get('SELECT * FROM leads WHERE phone = ?', [phone]);
  },

  create(phone, source = 'inbound', clientPhone = null) {
    db.run(`
      INSERT INTO leads (phone, client_phone, source, stage, created_at, updated_at)
      VALUES (?, ?, ?, 'new', datetime('now'), datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET updated_at = datetime('now')
    `, [phone, clientPhone, source]);
    return this.findByPhone(phone);
  },

  update(phone, fields) {
    const allowed = [
      'name','email','address','city','property_type','issue_type','urgency',
      'roof_size','has_other_quotes','timeline','budget_range','preferred_appointment',
      'notes','stage','priority','assigned_to','last_contact_at','client_phone'
    ];
    const pairs  = Object.entries(fields).filter(([k]) => allowed.includes(k));
    if (!pairs.length) return this.findByPhone(phone);
    const setClauses = pairs.map(([k]) => `${k} = ?`).join(', ');
    const values     = pairs.map(([, v]) => v);
    db.run(
      `UPDATE leads SET ${setClauses}, updated_at = datetime('now') WHERE phone = ?`,
      [...values, phone]
    );
    return this.findByPhone(phone);
  },

  list({ stage, priority, clientPhone, limit = 100, offset = 0 } = {}) {
    const conditions = ['1=1'];
    const params     = [];
    if (stage)       { conditions.push('stage = ?');        params.push(stage); }
    if (priority)    { conditions.push('priority = ?');     params.push(priority); }
    if (clientPhone) { conditions.push('client_phone = ?'); params.push(clientPhone); }
    params.push(limit, offset);
    return db.all(`
      SELECT * FROM leads WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT ? OFFSET ?
    `, params);
  },

  stats(clientPhone = null) {
    const w = clientPhone ? `AND client_phone = '${clientPhone}'` : '';
    return {
      total:           db.scalar(`SELECT COUNT(*) FROM leads WHERE 1=1 ${w}`) || 0,
      new:             db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'new' ${w}`) || 0,
      qualified:       db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'qualified' ${w}`) || 0,
      appointment_set: db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'appointment_set' ${w}`) || 0,
      won:             db.scalar(`SELECT COUNT(*) FROM leads WHERE stage = 'won' ${w}`) || 0,
      today:           db.scalar(`SELECT COUNT(*) FROM leads WHERE date(created_at) = date('now') ${w}`) || 0,
    };
  }
};

// ── Conversations ─────────────────────────────────────────────────────────────
const conversations = {
  add(phone, channel, direction, message, leadId = null) {
    db.run(
      'INSERT INTO conversations (lead_id, phone, channel, direction, message) VALUES (?,?,?,?,?)',
      [leadId, phone, channel, direction, message]
    );
  },

  getForPhone(phone, limit = 50) {
    return db.all(
      'SELECT * FROM conversations WHERE phone = ? ORDER BY created_at ASC LIMIT ?',
      [phone, limit]
    );
  }
};

// ── Follow-ups ────────────────────────────────────────────────────────────────
const followUps = {
  schedule(phone, message, scheduledAt, triggerType, leadId = null) {
    db.run(
      'INSERT INTO follow_ups (lead_id, phone, message, scheduled_at, trigger_type) VALUES (?,?,?,?,?)',
      [leadId, phone, message, scheduledAt, triggerType]
    );
  },

  getPending() {
    return db.all(`
      SELECT * FROM follow_ups
      WHERE status = 'pending' AND scheduled_at <= datetime('now')
      ORDER BY scheduled_at ASC
    `);
  },

  markSent(id) {
    db.run(
      "UPDATE follow_ups SET status = 'sent', sent_at = datetime('now') WHERE id = ?",
      [id]
    );
  },

  cancelForPhone(phone) {
    db.run(
      "UPDATE follow_ups SET status = 'cancelled' WHERE phone = ? AND status = 'pending'",
      [phone]
    );
  }
};

// ── AI Sessions ───────────────────────────────────────────────────────────────
const aiSessions = {
  get(phone) {
    const row = db.get('SELECT * FROM ai_sessions WHERE phone = ?', [phone]);
    if (!row) return null;
    return { ...row, messages: JSON.parse(row.messages) };
  },

  upsert(phone, messages, stage) {
    db.run(`
      INSERT INTO ai_sessions (phone, messages, stage, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET
        messages = excluded.messages,
        stage = excluded.stage,
        updated_at = datetime('now')
    `, [phone, JSON.stringify(messages), stage]);
  },

  clear(phone) {
    db.run('DELETE FROM ai_sessions WHERE phone = ?', [phone]);
  }
};

// ── Clients ───────────────────────────────────────────────────────────────────
const clients = {
  findByPhone(phoneNumber) {
    return db.get('SELECT * FROM clients WHERE phone_number = ?', [phoneNumber]);
  },

  list() {
    return db.all('SELECT * FROM clients ORDER BY created_at DESC');
  },

  create(data) {
    const existing = this.findByPhone(data.phone_number);
    if (existing) throw new Error(`A client with number ${data.phone_number} already exists.`);
    db.run(
      `INSERT INTO clients (phone_number, company_name, owner_phone, booking_url, forward_phone, voice)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.phone_number, data.company_name, data.owner_phone || null,
       data.booking_url || null, data.forward_phone || null,
       data.voice || 'Polly.Joanna-Neural']
    );
    return this.findByPhone(data.phone_number);
  },

  update(id, data) {
    const allowed = ['company_name','owner_phone','booking_url','forward_phone','voice','active'];
    const pairs = Object.entries(data).filter(([k]) => allowed.includes(k));
    if (!pairs.length) return;
    const setClauses = pairs.map(([k]) => `${k} = ?`).join(', ');
    const values = pairs.map(([, v]) => v);
    db.run(`UPDATE clients SET ${setClauses} WHERE id = ?`, [...values, id]);
    return db.get('SELECT * FROM clients WHERE id = ?', [id]);
  },

  delete(id) {
    db.run('DELETE FROM clients WHERE id = ?', [id]);
  },

  // Fallback config from .env when no DB client is found
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
