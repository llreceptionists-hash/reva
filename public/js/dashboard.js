'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const API_KEY = window.REVA_API_KEY || '';  // set via meta tag or env
const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

let currentView  = 'leads';
let selectedLead = null;
let leadsCache   = [];
let filterStage  = '';
let filterPriority = '';
let refreshTimer = null;

// ── API Helpers ──────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  showView('leads');
  // Auto-refresh every 30s
  refreshTimer = setInterval(() => {
    if (currentView === 'leads')    loadLeads();
    if (currentView === 'pipeline') loadPipeline();
  }, 30_000);
});

// ── Navigation ───────────────────────────────────────────────────────────────
function renderNav() {
  const items = [
    { id: 'leads',    icon: '👥', label: 'All Leads', reset: true },
    { id: 'pipeline', icon: '📊', label: 'Pipeline' },
    { id: 'followups',icon: '📬', label: 'Follow-ups' },
    { id: 'clients',  icon: '🏢', label: 'Clients' },
  ];
  const nav = document.getElementById('nav');
  nav.innerHTML = items.map(i => `
    <button class="nav-item ${currentView === i.id ? 'active' : ''}" onclick="${i.reset ? "filterStage='';filterPriority='';" : ''}showView('${i.id}')">
      <span class="icon">${i.icon}</span> ${i.label}
    </button>
  `).join('');
}

function showView(view) {
  currentView = view;
  renderNav();
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading"><span class="spinner"></span> Loading…</div>';

  if (view === 'leads')     loadLeads();
  if (view === 'pipeline')  loadPipeline();
  if (view === 'followups') loadFollowUps();
  if (view === 'clients')   loadClients();
}

// ── Leads View ───────────────────────────────────────────────────────────────
async function loadLeads() {
  try {
    const [leads, stats] = await Promise.all([
      api(`/leads?stage=${filterStage}&priority=${filterPriority}&limit=100`),
      api('/stats')
    ]);
    leadsCache = leads;
    renderLeadsView(leads, stats);
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="loading">Error loading leads: ${e.message}</div>`;
  }
}

function renderLeadsView(leads, stats) {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2>Leads</h2>
        <p>Manage and qualify roofing leads</p>
      </div>
      <button class="btn btn-primary" onclick="loadLeads()">↻ Refresh</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card today">
        <div class="label">Today</div>
        <div class="value">${stats.today}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total</div>
        <div class="value">${stats.total}</div>
      </div>
      <div class="stat-card">
        <div class="label">New</div>
        <div class="value">${stats.new}</div>
      </div>
      <div class="stat-card">
        <div class="label">Qualified</div>
        <div class="value">${stats.qualified}</div>
      </div>
      <div class="stat-card appt">
        <div class="label">Appt Set</div>
        <div class="value">${stats.appointment_set}</div>
      </div>
      <div class="stat-card won">
        <div class="label">Won</div>
        <div class="value">${stats.won}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span>All Leads (${leads.length})</span>
        <div class="filters">
          <select onchange="filterStage=this.value;loadLeads()">
            <option value="">All Stages</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="qualified">Qualified</option>
            <option value="appointment_set">Appt Set</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
          <select onchange="filterPriority=this.value;loadLeads()">
            <option value="">All Priorities</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Contact</th>
            <th>Issue</th>
            <th>Urgency</th>
            <th>Stage</th>
            <th>Priority</th>
            <th>Created</th>
            <th>Last Contact</th>
          </tr>
        </thead>
        <tbody>
          ${leads.length ? leads.map(renderLeadRow).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No leads yet</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function renderLeadRow(lead) {
  const name = lead.name || lead.phone;
  const created = formatDate(lead.created_at);
  const lastContact = lead.last_contact_at ? formatDate(lead.last_contact_at) : '—';
  return `
    <tr onclick="openLeadDetail('${lead.phone}')">
      <td>
        <strong>${escHtml(name)}</strong><br>
        <small style="color:var(--muted)">${lead.phone}</small>
      </td>
      <td>${escHtml(lead.issue_type || '—')}</td>
      <td>${lead.urgency ? `<span class="badge badge-${lead.urgency}">${label(lead.urgency)}</span>` : '—'}</td>
      <td><span class="badge badge-${lead.stage}">${label(lead.stage)}</span></td>
      <td><span class="badge badge-${lead.priority}">${label(lead.priority)}</span></td>
      <td>${created}</td>
      <td>${lastContact}</td>
    </tr>
  `;
}

// ── Lead Detail Panel ────────────────────────────────────────────────────────
async function openLeadDetail(phone) {
  try {
    const { lead, history } = await api(`/leads/${encodeURIComponent(phone)}`);
    selectedLead = lead;
    renderLeadPanel(lead, history);
  } catch (e) {
    alert('Error loading lead: ' + e.message);
  }
}

function renderLeadPanel(lead, history) {
  const existing = document.getElementById('detail-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'detail-overlay';
  overlay.className = 'detail-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-header">
        <div>
          <h3>${escHtml(lead.name || lead.phone)}</h3>
          <p>${lead.phone}${lead.email ? ' · ' + escHtml(lead.email) : ''}</p>
        </div>
        <button class="close-btn" onclick="document.getElementById('detail-overlay').remove()">✕</button>
      </div>

      <div class="detail-body">
        <!-- Stage & Priority -->
        <div class="detail-section">
          <h4>Status</h4>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <select id="stage-select" onchange="updateLead('${lead.phone}', {stage: this.value})">
              ${['new','contacted','qualified','appointment_set','won','lost'].map(s =>
                `<option value="${s}" ${lead.stage === s ? 'selected' : ''}>${label(s)}</option>`
              ).join('')}
            </select>
            <select id="priority-select" onchange="updateLead('${lead.phone}', {priority: this.value})">
              ${['high','normal','low'].map(p =>
                `<option value="${p}" ${lead.priority === p ? 'selected' : ''}>${label(p)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <!-- Lead Info -->
        <div class="detail-section">
          <h4>Lead Info</h4>
          <div class="detail-grid">
            <div class="detail-field"><label>Issue Type</label><span>${label(lead.issue_type) || '—'}</span></div>
            <div class="detail-field"><label>Property</label><span>${label(lead.property_type) || '—'}</span></div>
            <div class="detail-field"><label>Urgency</label><span>${lead.urgency ? `<span class="badge badge-${lead.urgency}">${label(lead.urgency)}</span>` : '—'}</span></div>
            <div class="detail-field"><label>Roof Size</label><span>${lead.roof_size || '—'}</span></div>
            <div class="detail-field"><label>Timeline</label><span>${lead.timeline || '—'}</span></div>
            <div class="detail-field"><label>Has Quotes?</label><span>${lead.has_other_quotes ? 'Yes' : 'No'}</span></div>
            <div class="detail-field"><label>Address</label><span>${escHtml(lead.address || lead.city || '—')}</span></div>
            <div class="detail-field"><label>Preferred Appt</label><span>${escHtml(lead.preferred_appointment || '—')}</span></div>
            <div class="detail-field"><label>Source</label><span>${label(lead.source)}</span></div>
            <div class="detail-field"><label>Assigned To</label>
              <input type="text" value="${escHtml(lead.assigned_to || '')}" placeholder="Unassigned"
                style="border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;width:100%"
                onchange="updateLead('${lead.phone}', {assigned_to: this.value})">
            </div>
          </div>
        </div>

        <!-- Notes -->
        <div class="detail-section">
          <h4>Notes</h4>
          <textarea id="notes-area" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:8px;font-size:13px;font-family:inherit;resize:vertical;min-height:60px"
            onblur="updateLead('${lead.phone}', {notes: this.value})">${escHtml(lead.notes || '')}</textarea>
        </div>

        <!-- Conversation History -->
        <div class="detail-section">
          <h4>Conversation (${history.length})</h4>
          <div class="conversation-list" id="conv-list">
            ${history.length ? history.map(renderMessage).join('') : '<p style="color:var(--muted);font-size:13px">No messages yet</p>'}
          </div>
        </div>

        <!-- SMS Composer -->
        <div class="detail-section">
          <h4>Send SMS</h4>
          <div class="sms-composer">
            <textarea id="sms-body" placeholder="Type a message…"></textarea>
            <button class="btn btn-primary btn-sm" onclick="sendManualSms('${lead.phone}')">Send</button>
          </div>
        </div>

        <!-- Actions -->
        <div class="detail-section">
          <h4>Actions</h4>
          <div class="msg-actions">
            <button class="btn btn-secondary btn-sm" onclick="cancelFollowUps('${lead.phone}')">Cancel Follow-ups</button>
            <button class="btn btn-success btn-sm" onclick="updateLead('${lead.phone}', {stage:'won'})">Mark Won ✓</button>
            <button class="btn btn-danger btn-sm" onclick="updateLead('${lead.phone}', {stage:'lost'})">Mark Lost</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Scroll conversation to bottom
  setTimeout(() => {
    const convList = document.getElementById('conv-list');
    if (convList) convList.scrollTop = convList.scrollHeight;
  }, 50);
}

function renderMessage(msg) {
  const dir = msg.direction === 'outbound' ? 'outbound' : 'inbound';
  const icon = msg.channel === 'voice' ? '📞' : (dir === 'outbound' ? '🤖' : '👤');
  return `
    <div class="msg-bubble ${dir}">
      <div>
        <div class="meta">${icon} ${msg.channel} · ${formatDate(msg.created_at)}</div>
        <div class="bubble">${escHtml(msg.message)}</div>
      </div>
    </div>
  `;
}

async function updateLead(phone, fields) {
  try {
    await api(`/leads/${encodeURIComponent(phone)}`, 'PATCH', fields);
    if (currentView === 'leads') loadLeads();
  } catch (e) {
    alert('Update failed: ' + e.message);
  }
}

async function sendManualSms(phone) {
  const body = document.getElementById('sms-body')?.value?.trim();
  if (!body) return alert('Please type a message.');
  try {
    await api(`/leads/${encodeURIComponent(phone)}/sms`, 'POST', { message: body });
    document.getElementById('sms-body').value = '';
    // Refresh conversation
    const { lead, history } = await api(`/leads/${encodeURIComponent(phone)}`);
    document.getElementById('conv-list').innerHTML =
      history.map(renderMessage).join('') || '<p style="color:var(--muted)">No messages</p>';
    document.getElementById('conv-list').scrollTop = 999999;
  } catch (e) {
    alert('Send failed: ' + e.message);
  }
}

async function cancelFollowUps(phone) {
  if (!confirm('Cancel all pending follow-ups for this lead?')) return;
  try {
    await api(`/leads/${encodeURIComponent(phone)}/follow-ups`, 'DELETE');
    alert('Follow-ups cancelled.');
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

// ── Pipeline View ────────────────────────────────────────────────────────────
async function loadPipeline() {
  try {
    const [pipeline, stats] = await Promise.all([api('/pipeline'), api('/stats')]);
    renderPipelineView(pipeline, stats);
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="loading">Error: ${e.message}</div>`;
  }
}

function renderPipelineView(pipeline, stats) {
  const stages = [
    { key: 'new',              label: 'New',         emoji: '🆕' },
    { key: 'contacted',        label: 'Contacted',   emoji: '💬' },
    { key: 'qualified',        label: 'Qualified',   emoji: '✅' },
    { key: 'appointment_set',  label: 'Appt Set',    emoji: '📅' },
    { key: 'won',              label: 'Won',          emoji: '🏆' },
    { key: 'lost',             label: 'Lost',         emoji: '❌' },
  ];

  document.getElementById('main-content').innerHTML = `
    <div class="page-header">
      <div><h2>Pipeline</h2><p>Lead funnel overview</p></div>
      <button class="btn btn-primary" onclick="loadPipeline()">↻ Refresh</button>
    </div>
    <div class="pipeline">
      ${stages.map(s => `
        <div class="pipe-col stage-${s.key}" onclick="filterStage='${s.key}';showView('leads')" style="cursor:pointer" title="Click to view ${s.label} leads">
          <div class="pipe-label">${s.emoji} ${s.label}</div>
          <div class="pipe-count">${pipeline[s.key] || 0}</div>
        </div>
      `).join('')}
    </div>
    <div class="card" style="margin-top:0">
      <div class="card-header">Conversion Rates</div>
      <div style="padding:16px;display:flex;gap:24px;flex-wrap:wrap">
        ${convRate('New → Contacted', pipeline.contacted, pipeline.new + pipeline.contacted)}
        ${convRate('Contacted → Qualified', pipeline.qualified, pipeline.contacted)}
        ${convRate('Qualified → Appt', pipeline.appointment_set, pipeline.qualified)}
        ${convRate('Appt → Won', pipeline.won, pipeline.appointment_set)}
      </div>
    </div>
  `;
}

function convRate(label, num, denom) {
  const rate = denom ? Math.round((num / denom) * 100) : 0;
  const color = rate > 60 ? 'var(--success)' : rate > 30 ? 'var(--warn)' : 'var(--danger)';
  return `
    <div style="text-align:center;min-width:120px">
      <div style="font-size:28px;font-weight:700;color:${color}">${rate}%</div>
      <div style="font-size:11px;color:var(--muted)">${label}</div>
    </div>
  `;
}

// ── Follow-ups View ───────────────────────────────────────────────────────────
async function loadFollowUps() {
  try {
    const fups = await api('/follow-ups/pending');
    renderFollowUpsView(fups);
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="loading">Error: ${e.message}</div>`;
  }
}

function renderFollowUpsView(fups) {
  document.getElementById('main-content').innerHTML = `
    <div class="page-header">
      <div><h2>Pending Follow-ups</h2><p>${fups.length} messages due</p></div>
      <button class="btn btn-primary" onclick="loadFollowUps()">↻ Refresh</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Phone</th><th>Trigger</th><th>Scheduled</th><th>Message</th></tr></thead>
        <tbody>
          ${fups.length ? fups.map(f => `
            <tr>
              <td><strong>${f.phone}</strong></td>
              <td>${label(f.trigger_type)}</td>
              <td>${formatDate(f.scheduled_at)}</td>
              <td style="max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(f.message)}</td>
            </tr>
          `).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:30px">No pending follow-ups</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function label(str) {
  if (!str) return '';
  return String(str).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Clients View ─────────────────────────────────────────────────────────────
async function loadClients() {
  try {
    const clientList = await api('/clients');
    renderClientsView(clientList);
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="loading">Error: ${e.message}</div>`;
  }
}

function renderClientsView(clientList) {
  document.getElementById('main-content').innerHTML = `
    <div class="page-header">
      <div><h2>🏢 Clients</h2><p>Manage roofing companies using Reva</p></div>
      <button class="btn btn-primary" onclick="showAddClientForm()">+ Add Client</button>
    </div>

    <div id="client-form-container"></div>

    <div class="card">
      <div class="card-header">Active Clients (${clientList.length})</div>
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Twilio Number</th>
            <th>Owner Phone</th>
            <th>Booking URL</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${clientList.length ? clientList.map(renderClientRow).join('') :
            '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">No clients yet — add your first one!</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function renderClientRow(c) {
  return `
    <tr>
      <td><strong>${escHtml(c.company_name)}</strong></td>
      <td><code style="font-size:12px">${escHtml(c.phone_number)}</code></td>
      <td>${escHtml(c.owner_phone || '—')}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${c.booking_url ? `<a href="${escHtml(c.booking_url)}" target="_blank" style="color:var(--accent)">${escHtml(c.booking_url)}</a>` : '—'}
      </td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="showEditClientForm(${JSON.stringify(c).replace(/"/g,'&quot;')})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteClient(${c.id}, '${escHtml(c.company_name)}')">Delete</button>
      </td>
    </tr>
  `;
}

function showAddClientForm() {
  document.getElementById('client-form-container').innerHTML = clientFormHtml({});
}

function showEditClientForm(c) {
  document.getElementById('client-form-container').innerHTML = clientFormHtml(c);
}

function clientFormHtml(c) {
  const isEdit = !!c.id;
  return `
    <div class="card" style="margin-bottom:16px;border:1px solid var(--accent)">
      <div class="card-header">${isEdit ? `Edit: ${escHtml(c.company_name)}` : 'Add New Client'}</div>
      <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Company Name *</label>
          <input id="cf-company" type="text" value="${escHtml(c.company_name||'')}" placeholder="Van City Roofing"
            style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Twilio Phone Number *</label>
          <input id="cf-phone" type="text" value="${escHtml(c.phone_number||'')}" placeholder="+16041234567"
            style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Owner's Cell (gets alerts)</label>
          <input id="cf-owner" type="text" value="${escHtml(c.owner_phone||'')}" placeholder="+16049876543"
            style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Booking URL (optional)</label>
          <input id="cf-booking" type="text" value="${escHtml(c.booking_url||'')}" placeholder="https://calendly.com/..."
            style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
        </div>
      </div>
      <div style="padding:0 16px 16px;display:flex;gap:10px">
        <button class="btn btn-primary btn-sm" onclick="${isEdit ? `saveEditClient(${c.id})` : 'saveNewClient()'}">
          ${isEdit ? 'Save Changes' : 'Add Client'}
        </button>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('client-form-container').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;
}

async function saveNewClient() {
  const data = {
    company_name: document.getElementById('cf-company').value.trim(),
    phone_number: document.getElementById('cf-phone').value.trim(),
    owner_phone:  document.getElementById('cf-owner').value.trim(),
    booking_url:  document.getElementById('cf-booking').value.trim(),
  };
  if (!data.company_name || !data.phone_number) return alert('Company name and phone number are required.');
  try {
    await api('/clients', 'POST', data);
    loadClients();
  } catch (e) { alert('Error: ' + e.message); }
}

async function saveEditClient(id) {
  const data = {
    company_name: document.getElementById('cf-company').value.trim(),
    owner_phone:  document.getElementById('cf-owner').value.trim(),
    booking_url:  document.getElementById('cf-booking').value.trim(),
  };
  try {
    await api(`/clients/${id}`, 'PATCH', data);
    loadClients();
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteClient(id, name) {
  if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
  try {
    await api(`/clients/${id}`, 'DELETE');
    loadClients();
  } catch (e) { alert('Error: ' + e.message); }
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7)    return `${diffD}d ago`;
  return d.toLocaleDateString();
}
