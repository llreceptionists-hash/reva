'use strict';

const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const { randomUUID } = require('crypto');

const { leads: leadsDb, conversations, followUps, aiSessions, clients } = require('../db/leads');
const { handleSmsConversation, generateVoiceResponse, classifyMessage } = require('../services/ai');
const { sendSms, alertOwner } = require('../services/sms');
const {
  buildGreetTwiml,
  buildSpeakAndGatherTwiml,
  buildClosingTwiml,
  buildForwardTwiml,
} = require('../services/voice');
const { getMissedCallText, getFollowUpMessages } = require('../prompts/system');

// In-memory voice session store
const voiceSessions = new Map();

// ---------------------------------------------------------------------------
// Twilio signature validation (production only)
// ---------------------------------------------------------------------------
function validateTwilio(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    req.headers['x-twilio-signature'] || '',
    `${process.env.BASE_URL}${req.originalUrl}`,
    req.body
  );
  if (!valid) return res.status(403).send('Forbidden');
  next();
}

router.use(express.urlencoded({ extended: false }));
router.use(validateTwilio);

// ---------------------------------------------------------------------------
// Helper: resolve which client a request is for based on the To number
// ---------------------------------------------------------------------------
function resolveClient(req) {
  const toNumber = req.body.To || req.body.Called;
  if (toNumber) {
    const found = clients.findByPhone(toNumber);
    if (found) return found;
  }
  return clients.getDefault();
}

// ---------------------------------------------------------------------------
// INBOUND SMS  →  POST /twilio/sms/inbound
// ---------------------------------------------------------------------------
router.post('/sms/inbound', async (req, res) => {
  const phone  = req.body.From;
  const body   = (req.body.Body || '').trim();
  const revaClient = resolveClient(req);

  console.log(`[SMS:IN] ${phone} → ${revaClient.company_name}: ${body}`);
  res.status(200).send('');

  try {
    const { isOptOut, isUrgent } = classifyMessage(body);

    if (isOptOut) {
      followUps.cancelForPhone(phone);
      aiSessions.clear(phone);
      leadsDb.update(phone, { stage: 'lost', notes: 'Opted out via STOP' });
      return;
    }

    let lead = leadsDb.findByPhone(phone);
    if (!lead) lead = leadsDb.create(phone, 'inbound_text', revaClient.phone_number);

    followUps.cancelForPhone(phone);
    conversations.add(phone, 'sms', 'inbound', body, lead.id);

    if (isUrgent && lead.urgency !== 'emergency') {
      leadsDb.update(phone, { urgency: 'emergency', priority: 'high' });
      await alertOwner(`EMERGENCY lead from ${phone}. Message: "${body.slice(0, 100)}"`, revaClient);
    }

    const { text, metadata, stage } = await handleSmsConversation(phone, body, revaClient);

    await sendSms(phone, text, revaClient.phone_number);
    conversations.add(phone, 'sms', 'outbound', text, lead.id);

    if (metadata?.next_action === 'book_appointment' || stage === 'closing') {
      const refreshed = leadsDb.findByPhone(phone);
      await alertOwner(
        `New QUALIFIED lead: ${refreshed.name || phone} | Issue: ${refreshed.issue_type || 'unknown'} | Urgency: ${refreshed.urgency || 'unknown'}`,
        revaClient
      );
    }

    const refreshedLead = leadsDb.findByPhone(phone);
    if (['new', 'contacted'].includes(refreshedLead.stage)) {
      const msgs = getFollowUpMessages(refreshedLead.name, revaClient);
      for (const fu of msgs) {
        const scheduledAt = new Date(Date.now() + fu.delay_hours * 3600 * 1000).toISOString();
        followUps.schedule(phone, fu.message, scheduledAt, 'no_response', refreshedLead.id);
      }
    }

  } catch (err) {
    console.error('[SMS:IN] Error:', err);
  }
});

// ---------------------------------------------------------------------------
// MISSED CALL  →  POST /twilio/voice/missed
// ---------------------------------------------------------------------------
router.post('/voice/missed', async (req, res) => {
  const phone      = req.body.From || req.body.Called;
  const callStatus = req.body.CallStatus;
  const revaClient = resolveClient(req);

  if (callStatus && !['no-answer', 'busy', 'failed'].includes(callStatus)) {
    console.log(`[MISSED] Ignoring status: ${callStatus} for ${phone}`);
    return res.status(200).send('');
  }

  console.log(`[MISSED] ${phone} → ${revaClient.company_name}`);
  res.status(200).send('');

  try {
    let lead = leadsDb.findByPhone(phone);
    if (!lead) lead = leadsDb.create(phone, 'missed_call', revaClient.phone_number);
    leadsDb.update(phone, { last_contact_at: new Date().toISOString() });
    conversations.add(phone, 'voice', 'inbound', '[Missed call]', lead.id);
    followUps.cancelForPhone(phone);

    const missedMsg = getMissedCallText(revaClient);
    await sendSms(phone, missedMsg, revaClient.phone_number);
    conversations.add(phone, 'sms', 'outbound', missedMsg, lead.id);

    const msgs = getFollowUpMessages(lead.name, revaClient);
    for (const fu of msgs) {
      const scheduledAt = new Date(Date.now() + fu.delay_hours * 3600 * 1000).toISOString();
      followUps.schedule(phone, fu.message, scheduledAt, 'missed_call', lead.id);
    }

  } catch (err) {
    console.error('[MISSED] Error:', err);
  }
});

// ---------------------------------------------------------------------------
// INBOUND CALL  →  POST /twilio/voice/inbound
// ---------------------------------------------------------------------------
router.post('/voice/inbound', async (req, res) => {
  const phone      = req.body.From;
  const revaClient = resolveClient(req);
  const sessionId  = `${phone.replace(/\D/g,'')}_${randomUUID().slice(0,8)}`;
  console.log(`[CALL:IN] ${phone} → ${revaClient.company_name} | Session: ${sessionId}`);

  let lead = leadsDb.findByPhone(phone);
  if (!lead) lead = leadsDb.create(phone, 'inbound', revaClient.phone_number);
  conversations.add(phone, 'voice', 'inbound', '[Inbound call answered]', lead.id);

  voiceSessions.set(sessionId, { phone, history: [], turn: 0, revaClient });

  res.type('text/xml').send(buildGreetTwiml(sessionId, revaClient));
});

// ---------------------------------------------------------------------------
// VOICE TURN  →  POST /twilio/voice/respond
// ---------------------------------------------------------------------------
router.post('/voice/respond', async (req, res) => {
  const sessionId  = req.query.session;
  const isFallback = req.query.fallback === '1';
  const speech     = req.body.SpeechResult || '';
  const session    = voiceSessions.get(sessionId);

  if (!session) {
    return res.type('text/xml').send(
      buildClosingTwiml("I'm sorry, I lost track of our conversation. Please call back and I'll help you right away!")
    );
  }

  const { phone, history, revaClient } = session;
  const turnCount = parseInt(req.query.turn || '0', 10);

  if (isFallback && turnCount > 1) {
    voiceSessions.delete(sessionId);
    return res.type('text/xml').send(buildClosingTwiml(
      `Thanks for calling! We'll follow up by text shortly. Have a great day!`, revaClient
    ));
  }

  if (speech) {
    conversations.add(phone, 'voice', 'inbound', speech, leadsDb.findByPhone(phone)?.id);
    history.push({ role: 'user', content: speech });
  }

  const { text, isDone } = await generateVoiceResponse(history, speech || '(no response)', revaClient);
  history.push({ role: 'assistant', content: text });
  voiceSessions.set(sessionId, { ...session, history, turn: turnCount });

  conversations.add(phone, 'voice', 'outbound', text, leadsDb.findByPhone(phone)?.id);

  const endPhrases = ['have a great day', 'goodbye', 'take care', 'bye'];
  const shouldEnd  = isDone || endPhrases.some(p => text.toLowerCase().includes(p));

  if (shouldEnd || turnCount >= 8) {
    voiceSessions.delete(sessionId);
    const lead = leadsDb.findByPhone(phone);
    if (lead) {
      const fullConvo = history.map(m => `${m.role === 'user' ? 'Customer' : 'Reva'}: ${m.content}`).join('\n');
      const apptMatch = fullConvo.match(/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:am|pm|:\d{2})|\bmorning\b|\bafternoon\b|\beverning\b|\btomorrow\b|\bnext week\b)/gi);
      const apptDetails = lead.preferred_appointment || (apptMatch ? apptMatch.join(', ') : null);

      const name = lead.name ? ` ${lead.name}` : '';
      const issue = lead.issue_type ? `for your ${lead.issue_type}` : 'for your roofing needs';
      const apptLine = apptDetails ? `\n📅 Appointment: ${apptDetails}` : '';

      const followUpText = `Hi${name}! Thanks for calling ${revaClient.company_name}. Here's your summary:${apptLine}\n🏠 Service: ${issue}\n✅ Our team will reach out to lock in your appointment. Reply here anytime!`;
      await sendSms(phone, followUpText, revaClient.phone_number).catch(() => {});
    }
    return res.type('text/xml').send(buildClosingTwiml(text, revaClient));
  }

  res.type('text/xml').send(buildSpeakAndGatherTwiml(text, sessionId, turnCount, revaClient));
});

// ---------------------------------------------------------------------------
// VOICEMAIL  →  POST /twilio/voice/voicemail
// ---------------------------------------------------------------------------
router.post('/voice/voicemail', async (req, res) => {
  const phone        = req.body.From;
  const recordingUrl = req.body.RecordingUrl;
  const revaClient   = resolveClient(req);
  console.log(`[VOICEMAIL] ${phone} | URL: ${recordingUrl}`);
  res.status(200).send('');

  try {
    let lead = leadsDb.findByPhone(phone);
    if (!lead) lead = leadsDb.create(phone, 'missed_call', revaClient.phone_number);
    conversations.add(phone, 'voice', 'inbound', `[Voicemail: ${recordingUrl}]`, lead.id);

    const vmText = `Hi! We got your voicemail and will call you back shortly. In the meantime, text us here for faster service! 🏠`;
    await sendSms(phone, vmText, revaClient.phone_number);
    conversations.add(phone, 'sms', 'outbound', vmText, lead.id);

    await alertOwner(`New voicemail from ${phone}: ${recordingUrl}`, revaClient);
  } catch (err) {
    console.error('[VOICEMAIL] Error:', err);
  }
});

// ---------------------------------------------------------------------------
// TRANSCRIPTION  →  POST /twilio/voice/transcription
// ---------------------------------------------------------------------------
router.post('/voice/transcription', (req, res) => {
  const phone = req.body.From;
  const text  = req.body.TranscriptionText;
  console.log(`[TRANSCRIPTION] ${phone}: ${text}`);
  res.status(200).send('');
  if (text) {
    const lead = leadsDb.findByPhone(phone);
    if (lead) conversations.add(phone, 'voice', 'inbound', `[Transcription] ${text}`, lead.id);
  }
});

module.exports = router;
