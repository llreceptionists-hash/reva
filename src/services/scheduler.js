'use strict';

const cron = require('node-cron');
const { followUps, leads: leadsDb, conversations } = require('../db/leads');
const { sendSms } = require('./sms');

let started = false;

async function processPendingFollowUps() {
  const pending = await followUps.getPending();
  if (!pending.length) return;

  console.log(`[SCHEDULER] Processing ${pending.length} follow-up(s)`);

  for (const fu of pending) {
    try {
      await sendSms(fu.phone, fu.message);
      await followUps.markSent(fu.id);

      const lead = await leadsDb.findByPhone(fu.phone);
      if (lead) {
        await leadsDb.update(fu.phone, { last_contact_at: new Date().toISOString() });
        await conversations.add(fu.phone, 'sms', 'outbound', fu.message, lead.id);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[SCHEDULER] Failed to send follow-up #${fu.id} to ${fu.phone}:`, err.message);
    }
  }
}

async function staleLeadDigest() {
  const { alertOwner } = require('./sms');
  const db = require('../db/database');

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  const stale = await db.all(`
    SELECT * FROM leads
    WHERE stage NOT IN ('won', 'lost')
    AND (last_contact_at IS NULL OR last_contact_at < $1)
    ORDER BY created_at DESC
    LIMIT 20
  `, [threeDaysAgo]);

  if (!stale.length) return;

  const lines = stale.map(l =>
    `• ${l.name || l.phone} | ${l.issue_type || 'unknown'} | Stage: ${l.stage}`
  ).join('\n');

  await alertOwner(`📋 ${stale.length} stale lead(s) need attention:\n${lines}`).catch(() => {});
}

function startScheduler() {
  if (started) return;
  started = true;

  cron.schedule('*/2 * * * *', () => {
    processPendingFollowUps().catch(err =>
      console.error('[SCHEDULER] Error in follow-up processor:', err)
    );
  });

  cron.schedule('0 9 * * *', () => {
    staleLeadDigest().catch(err =>
      console.error('[SCHEDULER] Error in stale lead digest:', err)
    );
  });

  console.log('[SCHEDULER] Started — follow-ups every 2 min, digest at 9 AM');
}

module.exports = { startScheduler, processPendingFollowUps };
