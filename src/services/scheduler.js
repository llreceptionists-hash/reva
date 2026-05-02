'use strict';

const cron = require('node-cron');
const { followUps, leads: leadsDb, conversations } = require('../db/leads');
const { sendSms } = require('./sms');

let started = false;

/**
 * Check and send any pending follow-up messages.
 * Runs every 2 minutes.
 */
async function processPendingFollowUps() {
  const pending = followUps.getPending();
  if (!pending.length) return;

  console.log(`[SCHEDULER] Processing ${pending.length} follow-up(s)`);

  for (const fu of pending) {
    try {
      await sendSms(fu.phone, fu.message);
      followUps.markSent(fu.id);

      const lead = leadsDb.findByPhone(fu.phone);
      if (lead) {
        leadsDb.update(fu.phone, { last_contact_at: new Date().toISOString() });
        conversations.add(fu.phone, 'sms', 'outbound', fu.message, lead.id);
      }

      // Small delay to avoid Twilio rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[SCHEDULER] Failed to send follow-up #${fu.id} to ${fu.phone}:`, err.message);
    }
  }
}

/**
 * Daily digest: alert owner of leads that haven't been touched in 3+ days.
 * Runs at 9 AM.
 */
async function staleLeadDigest() {
  const { alertOwner } = require('./sms');
  const db = require('../db/database');

  // Calculate 3 days ago as ISO string for comparison
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  const stale = db.all(`
    SELECT * FROM leads
    WHERE stage NOT IN ('won', 'lost')
    AND (last_contact_at IS NULL OR last_contact_at < ?)
    ORDER BY created_at DESC
    LIMIT 20
  `, [threeDaysAgo]);

  if (!stale.length) return;

  const lines = stale.map(l =>
    `• ${l.name || l.phone} | ${l.issue_type || 'unknown'} | Stage: ${l.stage}`
  ).join('\n');

  await alertOwner(`📋 ${stale.length} stale lead(s) need attention:\n${lines}`).catch(() => {});
}

/**
 * Start the scheduler — called once at app startup.
 */
function startScheduler() {
  if (started) return;
  started = true;

  // Every 2 minutes: process follow-ups
  cron.schedule('*/2 * * * *', () => {
    processPendingFollowUps().catch(err =>
      console.error('[SCHEDULER] Error in follow-up processor:', err)
    );
  });

  // Daily at 9 AM: stale lead digest
  cron.schedule('0 9 * * *', () => {
    staleLeadDigest().catch(err =>
      console.error('[SCHEDULER] Error in stale lead digest:', err)
    );
  });

  console.log('[SCHEDULER] Started — follow-ups every 2 min, digest at 9 AM');
}

module.exports = { startScheduler, processPendingFollowUps };
