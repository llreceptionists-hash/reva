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
const { textToSpeech } = require('../services/elevenlabs');

// In-memory voice session store
const voiceSessions = new Map();

// In-memory audio cache (sessionId → Buffer)
const audioCache = new Map();

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
// AUDIO SERVING  →  GET /twilio/voice/audio/:id
// Serves ElevenLabs generated audio to Twilio <Play>
// ---------------------------------------------------------------------------
router.get('/voice/audio/:id', (req, res) => {
  const audio = audioCache.get(req.params.id);
  if (!audio) return res.status(404).send('Not found');
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', audio.length);
  res.send(audio);
  // Clean up after serving
  setTimeout(() => audioCache.delete(req.params.id), 30000);
});

// ---------------------------------------------------------------------------
// Helper: generate ElevenLabs audio and return TwiML <Play> URL
// Falls back to <Say> if ElevenLabs fails
// ---------------------------------------------------------------------------
async function buildElevenLabsTwiml(text, gatherAction, fallbackRedirect, revaClient) {
  const twilio = require('twilio');
  const { VoiceResponse } = twilio.twiml;
  const BASE_URL = process.env.BASE_URL || 'https://yourdomain.com';
  const resp = new VoiceResponse();

  try {
    const voiceId = revaClient?.voice_id || process.env.ELEVENLABS_VOICE_ID || 'kdmDKE6EkgrWrrykO9Qt';
    const audio = await textToSpeech(text, voiceId);
    const audioId = randomUUID();
    audioCache.set(audioId, audio);

    if (gatherAction) {
      const gather = resp.gather({
        input: 'speech',
        action: gatherAction,
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US',
      });
      gather.play(`${BASE_URL}/twilio/voice/audio/${audioId}`);
      if (fallbackRedirect) resp.redirect({ method: 'POST' }, fallbackRedirect);
    } else {
      resp.play(`${BASE_URL}/twilio/voice/audio/${audioId}`);
      resp.hangup();
    }
  } catch (err) {
    console.error('[ElevenLabs] TTS failed, falling back to Polly:', err.message);
    // Fallback to Polly
    const voice = revaClient?.voice || process.env.TWILIO_VOICE || 'Polly.Joanna-Neural';
    if (gatherAction) {
      const gather = resp.gather({ input: 'speech', action: gatherAction, method: 'POST', speechTimeout: 'auto' });
      gather.say({ voice }, text);
      if (fallbackRedirect) resp.redirect({ method: 'POST' }, fallbackRedirect);
    } else {
      resp.say({ voice }, text);
      resp.hangup();
    }
  }

  return resp.toString();
}

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

  const BASE_URL = process.env.BASE_URL || 'https://yourdomain.com';
  const greetText = `Hey, thanks for calling ${revaClient.company_name}! This is Reva. What can I help you with today?`;
  const twiml = await buildElevenLabsTwiml(
    greetText,
    `${BASE_URL}/twilio/voice/respond?session=${sessionId}`,
    `${BASE_URL}/twilio/voice/respond?session=${sessionId}&fallback=1`,
    revaClient
  );
  res.type('text/xml').send(twiml);
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

  const BASE_URL = process.env.BASE_URL || 'https://yourdomain.com';

  if (isFallback && turnCount > 1) {
    voiceSessions.delete(sessionId);
    const byeTwiml = await buildElevenLabsTwiml(
      `Thanks for calling! We'll follow up by text shortly.`,
      null, null, revaClient
    );
    return res.type('text/xml').send(byeTwiml);
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
    const closingTwiml = await buildElevenLabsTwiml(text, null, null, revaClient);
    return res.type('text/xml').send(closingTwiml);
  }

  const nextAction = `${BASE_URL}/twilio/voice/respond?session=${sessionId}&turn=${turnCount + 1}`;
  const nextFallback = `${BASE_URL}/twilio/voice/respond?session=${sessionId}&turn=${turnCount + 1}&fallback=1`;
  const twiml = await buildElevenLabsTwiml(text, nextAction, nextFallback, revaClient);
  res.type('text/xml').send(twiml);
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
