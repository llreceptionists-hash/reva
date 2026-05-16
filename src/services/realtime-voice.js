'use strict';

/**
 * GPT-4o Realtime API bridge for Twilio Media Streams.
 *
 * Phone/client info comes from the Twilio <Stream><Parameter> elements
 * inside the 'start' event — no query params needed on the WebSocket URL.
 */

const WebSocket  = require('ws');
const Anthropic  = require('@anthropic-ai/sdk');
const { leads: leadsDb, conversations, followUps, clients } = require('../db/leads');
const { alertOwner, sendSms }                    = require('./sms');
const { getVoiceSystemPrompt }                   = require('../prompts/system');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Pricing calculator ────────────────────────────────────────────────────────
function getEstimateRange(issueType, roofSize, notes) {
  if (!issueType) return null;
  const issue = issueType.toLowerCase();
  const size  = (roofSize || notes || '').toLowerCase();

  const isSmall  = /small|tiny|bungalow|1\s*stor|one.stor|1000|1100|1200|1300|1400|1500/.test(size);
  const isLarge  = /large|big|3\s*stor|three.stor|2500|3000|3500|4000|huge/.test(size);
  const isMed    = !isSmall && !isLarge;

  // Moss / roof cleaning
  if (/moss|algae|lichen|roof\s*clean|roof\s*treat/.test(issue)) {
    if (isSmall)  return '$250–$450';
    if (isLarge)  return '$700–$1,100+';
    return '$450–$700'; // medium default
  }

  // Gutter cleaning
  if (/gutter/.test(issue)) {
    const hasGuards = /guard/.test(size + issue);
    if (isSmall)  return hasGuards ? '$170–$280' : '$120–$180';
    if (isLarge)  return hasGuards ? '$380–$500' : '$280–$400';
    return hasGuards ? '$250–$380' : '$180–$280';
  }

  // Pressure washing
  if (/pressure|wash|driveway|patio|siding/.test(issue)) {
    if (isSmall)  return '$150–$250';
    if (isLarge)  return '$400–$600+';
    return '$250–$400';
  }

  // Window cleaning
  if (/window/.test(issue)) {
    if (isSmall)  return '$100–$200';
    if (isLarge)  return '$350–$550';
    return '$200–$350';
  }

  // Multiple services
  if (/multiple|everything|all|combo|package/.test(issue)) {
    return '$400–$900+ depending on services';
  }

  return null; // unknown service — don't guess
}

// Extract structured lead data from transcript using Claude
async function extractLeadFromTranscript(transcript) {
  const text = transcript.map(m => `${m.role === 'user' ? 'Customer' : 'Reva'}: ${m.text}`).join('\n');
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Extract lead info from this roofing call transcript. Return ONLY valid JSON, nothing else.

Transcript:
${text}

Return this JSON (use null for anything not mentioned):
{
  "name": "customer full name or null",
  "address": "full address or null",
  "city": "city or null",
  "issue_type": "exact words customer used to describe the problem or null",
  "urgency": "emergency|urgent|normal|low or null",
  "property_type": "residential|commercial or null",
  "preferred_appointment": "day and time they agreed to or null",
  "roof_size": "small|medium|large or approximate sqft if mentioned or null",
  "notes": "any extra details like shingle type, gutter guards, storeys, etc or null"
}`
      }],
    });
    const raw = msg.content[0].text.trim();
    const json = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(json);
  } catch (err) {
    console.error('[EXTRACT] Failed to extract lead data:', err.message);
    return null;
  }
}

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

// ── Audio conversion ─────────────────────────────────────────────────────────

const ULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const b    = ~i & 0xFF;
  const sign = b & 0x80;
  const exp  = (b >> 4) & 0x07;
  const mant = b & 0x0F;
  let s = ((mant << 3) + 132) << exp;
  s -= 132;
  ULAW_DECODE[i] = sign ? -s : s;
}

function mulawToPcm16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(ULAW_DECODE[buf[i]], i * 2);
  return out;
}

function pcm16ToMulaw(buf) {
  const out = Buffer.alloc(buf.length >> 1);
  for (let i = 0; i < out.length; i++) {
    let s = buf.readInt16LE(i * 2);
    const sign = (s < 0) ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > 32767) s = 32767;
    s += 132;
    let exp = 7;
    for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
    const mant = (s >> (exp + 3)) & 0x0F;
    out[i] = (~(sign | (exp << 4) | mant)) & 0xFF;
  }
  return out;
}

function upsample8to24(buf) {
  const n   = buf.length >> 1;
  const out = Buffer.alloc(n * 6);
  for (let i = 0; i < n; i++) {
    const s0 = buf.readInt16LE(i * 2);
    const s1 = (i + 1 < n) ? buf.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0,                                  i * 6);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) / 3),     i * 6 + 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * 2 / 3), i * 6 + 4);
  }
  return out;
}

function downsample24to8(buf) {
  const n   = Math.floor((buf.length >> 1) / 3);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // Average 3 samples instead of decimating — reduces aliasing/static
    const s1 = buf.readInt16LE(i * 6);
    const s2 = buf.readInt16LE(i * 6 + 2);
    const s3 = buf.readInt16LE(i * 6 + 4);
    out.writeInt16LE(Math.round((s1 + s2 + s3) / 3), i * 2);
  }
  return out;
}

// ── Bridge ───────────────────────────────────────────────────────────────────

function createRealtimeBridge(twilioWs) {
  let streamSid      = null;
  let callSid        = null;
  let openAiWs       = null;
  let callEnded      = false;
  let openAiReady    = false;
  let greetingDone   = false; // prevent VAD interrupting the opening greeting
  let phone          = 'unknown';
  let revaClient     = null;
  let lastAudioAt    = 0;    // timestamp of last audio delta — used for hangup timing
  let hangupPending  = false;
  const transcript   = [];
  const audioQueue   = []; // buffer while OpenAI is connecting

  // ── Twilio → us ────────────────────────────────────────────────────────────

  twilioWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      case 'start': {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;
        const cp  = msg.start.customParameters || {};
        phone     = cp.phone || 'unknown';
        const clientPhone = cp.clientPhone || '';

        // Resolve which roofing company this call is for
        try {
          revaClient = clientPhone ? await clients.findByPhone(clientPhone) : null;
        } catch {}
        if (!revaClient) revaClient = clients.getDefault();

        console.log(`[REALTIME] Stream started: ${phone} → ${revaClient.company_name}`);

        // Ensure lead record exists
        try {
          let lead = await leadsDb.findByPhone(phone);
          if (!lead) await leadsDb.create(phone, 'inbound', revaClient.phone_number);
          else await leadsDb.update(phone, { last_contact_at: new Date().toISOString() });
        } catch (err) {
          console.error('[REALTIME] lead init error:', err.message);
        }

        setupOpenAI();
        break;
      }

      case 'media': {
        if (openAiReady && openAiWs?.readyState === WebSocket.OPEN) {
          forwardToOpenAI(msg.media.payload);
        } else if (!openAiReady) {
          audioQueue.push(msg.media.payload);
        }
        break;
      }

      case 'stop':
        endCall();
        break;
    }
  });

  twilioWs.on('close', () => endCall());
  twilioWs.on('error', (err) => console.error('[REALTIME] Twilio WS error:', err.message));

  // ── Audio helpers ───────────────────────────────────────────────────────────

  function forwardToOpenAI(base64mulaw) {
    // Session configured with input_audio_format: 'g711_ulaw' — pass mulaw straight through
    openAiWs.send(JSON.stringify({
      type:  'input_audio_buffer.append',
      audio: base64mulaw,
    }));
  }

  function sendToTwilio(base64ulaw) {
    // Session configured with output_audio_format: 'g711_ulaw' — pass straight to Twilio
    if (!streamSid) return;
    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64ulaw },
    }));
  }

  // ── OpenAI setup ────────────────────────────────────────────────────────────

  function setupOpenAI() {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[REALTIME] OPENAI_API_KEY not set');
      twilioWs.close();
      return;
    }

    openAiWs = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });

    openAiWs.on('open', () => {
      console.log(`[REALTIME] OpenAI connected for ${phone}`);
      // Wait for session.created before doing anything
    });

    openAiWs.on('message', async (raw) => {
      try {
        const ev = JSON.parse(raw);
        switch (ev.type) {

          case 'session.created': {
            console.log(`[REALTIME] session.created, configuring...`);
            const tz  = process.env.TIMEZONE || 'America/Vancouver';
            const now = new Date().toLocaleString('en-US', {
              timeZone: tz, weekday: 'long', year: 'numeric',
              month: 'long', day: 'numeric',
              hour: 'numeric', minute: '2-digit', hour12: true,
            });
            const systemPrompt = getVoiceSystemPrompt(revaClient) +
              `\n\nCURRENT DATE & TIME: ${now} (${tz}).` +
              '\n\nOnly use info from this call. Never assume you know the customer\'s name or details.';
            openAiWs.send(JSON.stringify({
              type: 'session.update',
              session: {
                type:                'realtime',
                instructions:        systemPrompt,
                output_modalities:   ['audio'],
                input_audio_format:  'g711_ulaw',
                output_audio_format: 'g711_ulaw',
              },
            }));
            break;
          }

          case 'session.updated':
            console.log(`[REALTIME] session.updated — triggering greeting`);
            openAiReady = true;
            audioQueue.length = 0;
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
            break;

          case 'input_audio_buffer.speech_started':
            // Only allow interruptions after the greeting is fully done
            if (greetingDone && streamSid) {
              twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
            }
            break;

          case 'response.done':
            // Mark greeting as done after a fixed delay — OpenAI sends all
            // audio deltas quickly (faster than real-time), so lastAudioAt
            // goes stale while Twilio is still playing the greeting.
            // 4s gives enough headroom for any intro length.
            if (!greetingDone) {
              setTimeout(() => { greetingDone = true; }, 4000);
            }
            break;

          case 'response.audio.delta':
            if (ev.delta) {
              sendToTwilio(ev.delta);
              lastAudioAt = Date.now();
            }
            break;

          case 'response.audio_transcript.done':
            if (ev.transcript) {
              transcript.push({ role: 'assistant', text: ev.transcript });
              console.log(`[REALTIME] AI: ${ev.transcript.slice(0, 80)}`);
              // Hang up after a clear goodbye — only if it's a short closing message
              // to avoid triggering mid-conversation on phrases like "take care of your roof"
              const text  = ev.transcript.toLowerCase().trim();
              const words = text.split(/\s+/);
              const isShortMessage = words.length < 25;
              // Only check the tail of the message — prevents mid-convo confirmation
              // phrases like "have a good one" from triggering early hangup
              const lastWords  = words.slice(-6).join(' ');
              const tailWords  = words.slice(-15).join(' ');
              const clearGoodbye = ['have a great day', 'have a good day', 'have a good one', 'talk soon', 'goodbye', 'take care now'];
              const shortGoodbye = ['bye', 'take care'];
              const isGoodbye = clearGoodbye.some(p => tailWords.includes(p)) ||
                                (isShortMessage && shortGoodbye.some(p => lastWords.includes(p)));
              if (isGoodbye && !hangupPending) {
                hangupPending = true;
                // Wait until OpenAI stops sending audio (1s silence on our end),
                // then add 5s for Twilio to finish draining its audio buffer.
                // OpenAI sends deltas faster than real-time so Twilio can have
                // several seconds of audio queued up after we stop receiving deltas.
                const pollInterval = setInterval(() => {
                  const silentMs = Date.now() - lastAudioAt;
                  if (silentMs >= 1000) {
                    clearInterval(pollInterval);
                    setTimeout(() => hangUp(), 5000);
                  }
                }, 200);
              }
            }
            break;

          case 'conversation.item.input_audio_transcription.completed':
            if (ev.transcript) {
              transcript.push({ role: 'user', text: ev.transcript });
              console.log(`[REALTIME] User: ${ev.transcript.slice(0, 80)}`);
            }
            break;

          case 'response.function_call_arguments.done':
            if (ev.name === 'update_lead') await handleLeadUpdate(ev);
            break;

          case 'error':
            console.error('[REALTIME] OpenAI error:', JSON.stringify(ev.error));
            break;
        }
      } catch (err) {
        console.error('[REALTIME] message handler error:', err);
      }
    });

    openAiWs.on('error', (err) => console.error('[REALTIME] OpenAI WS error:', err.message));
    openAiWs.on('close', (code, reason) => console.log(`[REALTIME] OpenAI WS closed — code: ${code}, reason: ${reason?.toString() || 'none'}`));
  }

  // ── Lead update tool call ───────────────────────────────────────────────────

  // Common words the AI mistakenly saves as names
  const NOT_A_NAME = new Set([
    'house','home','roof','roofing','leak','repair','damage','storm','wind','rain',
    'attic','ceiling','shingle','shingles','gutters','chimney','flat','pitched',
    'residential','commercial','industrial','business','property','building',
    'yes','no','ok','okay','sure','thanks','hello','hi','hey','there','just',
    'about','actually','well','so','and','the','my','our','your','their',
    'small','big','large','minor','major','urgent','emergency','bad','good',
    'calling','looking','having','getting','need','want','trying',
  ]);

  async function handleLeadUpdate(ev) {
    try {
      const args = JSON.parse(ev.arguments || '{}');
      console.log(`[REALTIME] update_lead raw:`, args);

      // Server-side validation — reject clearly wrong values before DB write
      if (args.name) {
        const first = args.name.trim().split(/\s+/)[0].toLowerCase();
        if (NOT_A_NAME.has(first) || args.name.trim().length < 2) {
          console.warn(`[REALTIME] Rejected bad name: "${args.name}"`);
          delete args.name;
        }
      }

      // Normalize property_type — AI sometimes sends 'townhouse', 'condo' etc.
      if (args.property_type) {
        const pt = args.property_type.toLowerCase();
        const residentialWords = ['house','townhouse','condo','condominium','apartment','home','duplex','residential'];
        const commercialWords  = ['commercial','business','office','warehouse','store','shop','industrial','building'];
        if (residentialWords.some(w => pt.includes(w)))      args.property_type = 'residential';
        else if (commercialWords.some(w => pt.includes(w)))  args.property_type = 'commercial';
        else { console.warn(`[REALTIME] Unknown property_type: "${args.property_type}"`); delete args.property_type; }
      }

      if (!Object.keys(args).length) {
        // Nothing valid to save — still need to ack the tool call
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true}' },
        }));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
        return;
      }

      const prev = await leadsDb.findByPhone(phone);
      await leadsDb.update(phone, args);
      console.log(`[REALTIME] update_lead saved:`, args);

      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true}' },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));

      // Alert owner when appointment is set or changes
      if (args.preferred_appointment && args.preferred_appointment !== prev?.preferred_appointment) {
        const r = await leadsDb.findByPhone(phone);
        await alertOwner(
          `📞 NEW CALL LEAD — Appointment set!\n` +
          `👤 Name: ${r?.name || 'Unknown'}\n📞 Phone: ${phone}\n` +
          `📍 ${r?.address || r?.city || 'TBD'}\n` +
          `🔧 Issue: ${r?.issue_type || '?'}\n` +
          `📅 Appt: ${args.preferred_appointment}\n💬 Source: Phone call`,
          revaClient
        ).catch(console.error);
      }
    } catch (err) {
      console.error('[REALTIME] handleLeadUpdate error:', err);
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":false}' },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  // ── Hang up ──────────────────────────────────────────────────────────────────

  async function hangUp() {
    if (!callSid || callEnded) return;
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.calls(callSid).update({ status: 'completed' });
      console.log(`[REALTIME] Hung up call ${callSid}`);
    } catch (err) {
      console.error('[REALTIME] hangUp error:', err.message);
    }
  }

  // ── Call end ────────────────────────────────────────────────────────────────

  function endCall() {
    if (callEnded) return;
    callEnded = true;
    if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
    saveCallAndAlert().catch(console.error);
  }

  async function saveCallAndAlert() {
    if (!transcript.length) return;
    try {
      // Skip everything if it was an accidental call
      const accidentalPhrases = [
        'wrong number', 'accident', 'accidental', 'meant to call', 'wrong person',
        'my bad', 'oops', 'nevermind', 'never mind', 'forget it', 'changed my mind',
        'not anymore', 'don\'t need', 'dont need', 'no longer', 'not interested',
        'figured it out', 'all good now', 'sorted it out', 'never mind',
        'was gonna call but', 'going to call but', 'thought i\'d call but',
      ];
      const wasAccidental = transcript.some(m =>
        m.role === 'user' && accidentalPhrases.some(p => m.text.toLowerCase().includes(p))
      );
      if (wasAccidental) {
        console.log(`[REALTIME] Accidental call from ${phone} — skipping alert and SMS`);
        return;
      }

      const lead = await leadsDb.findByPhone(phone);
      if (!lead) return;

      // Skip everything for very short calls where nothing was captured
      const userMessages = transcript.filter(m => m.role === 'user');
      if (userMessages.length <= 1) {
        console.log(`[REALTIME] Very short call from ${phone} — skipping`);
        return;
      }

      // Extract structured data from transcript using Claude — more reliable
      // than depending on the AI to call update_lead() during the call
      const extracted = await extractLeadFromTranscript(transcript);
      if (extracted) {
        console.log(`[REALTIME] Extracted from transcript:`, extracted);
        // Normalize property_type
        if (extracted.property_type) {
          const pt = extracted.property_type.toLowerCase();
          if (!['residential','commercial'].includes(pt)) delete extracted.property_type;
        }
        // Filter out nulls before saving
        const toSave = Object.fromEntries(Object.entries(extracted).filter(([, v]) => v !== null));
        if (Object.keys(toSave).length) await leadsDb.update(phone, toSave);
      }

      for (const m of transcript) {
        await conversations.add(
          phone, 'voice',
          m.role === 'user' ? 'inbound' : 'outbound',
          m.text, lead.id
        ).catch(() => {});
      }

      let r = await leadsDb.findByPhone(phone);
      if (!r) return;

      const name  = r.name ? ` ${r.name.split(' ')[0]}` : '';
      const lines = [
        r.issue_type            ? `🔧 Issue: ${r.issue_type}` : '',
        r.address || r.city     ? `📍 ${r.address || r.city}` : '',
        r.preferred_appointment ? `📅 Appt: ${r.preferred_appointment}` : '',
      ].filter(Boolean);

      if (lines.length) {
        await sendSms(
          phone,
          `Hi${name}! Here's your summary from ${revaClient.company_name}:\n\n${lines.join('\n')}\n\n✅ Our team will confirm shortly. Reply anytime!`,
          revaClient.phone_number
        ).catch(() => {});
      }

      const estimate = getEstimateRange(r.issue_type, r.roof_size, r.notes);

      await alertOwner(
        `📞 NEW CALL LEAD — Call them back!\n` +
        `👤 Name: ${r.name || 'Unknown'}\n📞 Phone: ${phone}\n` +
        `📍 ${r.address || r.city || 'Not given'}\n` +
        `🔧 Issue: ${r.issue_type || '?'}\n` +
        `📐 Size: ${r.roof_size || 'Not specified'}\n` +
        (estimate ? `💰 Est. Range: ${estimate}\n` : '') +
        `⚡ Urgency: ${r.urgency || 'Normal'}\n` +
        `🏡 Property: ${r.property_type || '?'}\n` +
        `📅 Appt: ${r.preferred_appointment || 'Not set'}\n` +
        `💬 Source: Phone call`,
        revaClient
      ).catch(console.error);

      // Schedule follow-ups if no appointment was booked
      if (!r.preferred_appointment) {
        const { getFollowUpMessages } = require('../prompts/system');
        const fuMessages = getFollowUpMessages(r.name, revaClient);
        await followUps.cancelForPhone(phone);
        for (const fu of fuMessages) {
          const scheduledAt = new Date(Date.now() + fu.delay_hours * 3600 * 1000).toISOString();
          await followUps.schedule(phone, fu.message, scheduledAt, 'no_response', r.id).catch(() => {});
        }
        console.log(`[REALTIME] Scheduled ${fuMessages.length} follow-ups for ${phone}`);
      }

    } catch (err) {
      console.error('[REALTIME] saveCallAndAlert error:', err);
    }
  }
}

module.exports = { createRealtimeBridge };
