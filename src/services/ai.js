'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getSmsSystemPrompt, getVoiceSystemPrompt } = require('../prompts/system');
const { aiSessions, leads: leadsDb } = require('../db/leads');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseRevaResponse(raw) {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  let metadata = null;
  let text = raw;

  if (jsonMatch) {
    try { metadata = JSON.parse(jsonMatch[1]); } catch (_) {}
    text = raw.replace(/```json[\s\S]*?```/, '').trim();
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, metadata };
}

function applyMetadataToLead(phone, metadata) {
  if (!metadata || !metadata.captured) return;

  const updates = {};
  const c = metadata.captured;

  if (c.name)                  updates.name                 = c.name;
  if (c.address)               updates.address              = c.address;
  if (c.city)                  updates.city                 = c.city;
  if (c.property_type)         updates.property_type        = c.property_type;
  if (c.issue_type)            updates.issue_type           = c.issue_type;
  if (c.urgency)               updates.urgency              = c.urgency;
  if (c.preferred_appointment) updates.preferred_appointment = c.preferred_appointment;
  if (c.timeline)              updates.timeline             = c.timeline;
  if (c.notes)                 updates.notes                = c.notes;
  if (c.has_other_quotes !== null && c.has_other_quotes !== undefined)
                               updates.has_other_quotes     = c.has_other_quotes ? 1 : 0;

  if (metadata.priority)       updates.priority             = metadata.priority;
  if (metadata.stage === 'booking' || metadata.stage === 'closing')
                               updates.stage                = 'qualified';
  if (metadata.next_action === 'book_appointment')
                               updates.stage                = 'appointment_set';

  updates.last_contact_at = new Date().toISOString();

  if (Object.keys(updates).length) leadsDb.update(phone, updates);
}

/**
 * Main SMS conversation handler.
 */
async function handleSmsConversation(phone, inboundMessage, revaClient = null) {
  let session = aiSessions.get(phone);
  const lead  = leadsDb.findByPhone(phone);

  let messages     = session ? session.messages : [];
  let sessionStage = session ? session.stage    : 'greeting';

  messages.push({ role: 'user', content: inboundMessage });

  const systemPrompt = getSmsSystemPrompt(lead, revaClient);

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      system: systemPrompt,
      messages,
    });

    const raw = response.content.find(b => b.type === 'text')?.text ?? '';
    const { text, metadata } = parseRevaResponse(raw);

    messages.push({ role: 'assistant', content: raw });

    if (metadata?.stage) sessionStage = metadata.stage;

    const trimmed = messages.slice(-20);
    aiSessions.upsert(phone, trimmed, sessionStage);
    applyMetadataToLead(phone, metadata);

    return { text, metadata, stage: sessionStage };

  } catch (err) {
    console.error('[AI] SMS conversation error:', err.message);
    return {
      text: "I'm having a quick hiccup — please reply again and I'll be right with you! 🙏",
      metadata: null,
      stage: sessionStage
    };
  }
}

/**
 * Generate a single voice response turn.
 */
async function generateVoiceResponse(conversationHistory, userSpeech, revaClient = null) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: userSpeech || '(caller said nothing)' }
  ];

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 150,
      system: getVoiceSystemPrompt(revaClient),
      messages,
    });

    const text = response.content.find(b => b.type === 'text')?.text ??
      "I'm sorry, I didn't catch that. Could you please repeat?";

    const doneSignals = ['goodbye', 'have a great day', 'take care', 'bye', "we'll be in touch", 'we will be in touch'];
    const isDone = doneSignals.some(s => text.toLowerCase().includes(s));

    return { text, isDone };
  } catch (err) {
    console.error('[AI] Voice response error:', err.message);
    return { text: "One moment please, let me connect you with our team.", isDone: true };
  }
}

function classifyMessage(text) {
  const lower = text.toLowerCase().trim();
  const stopWords    = ['stop', 'unsubscribe', 'cancel', 'quit', 'end', 'opt out'];
  const urgencyWords = ['emergency', 'flood', 'leak', 'urgent', 'asap', 'immediately', 'now', 'flooded'];

  return {
    isOptOut: stopWords.some(w => lower === w || lower.startsWith(w + ' ')),
    isUrgent: urgencyWords.some(w => lower.includes(w)),
  };
}

module.exports = { handleSmsConversation, generateVoiceResponse, classifyMessage };
