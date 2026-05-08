'use strict';

/**
 * GPT-4o Realtime API bridge for Twilio Media Streams.
 *
 * Phone/client info comes from the Twilio <Stream><Parameter> elements
 * inside the 'start' event — no query params needed on the WebSocket URL.
 */

const WebSocket = require('ws');
const { leads: leadsDb, conversations, clients } = require('../db/leads');
const { alertOwner, sendSms }                    = require('./sms');
const { getVoiceSystemPrompt }                   = require('../prompts/system');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';

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
  let streamSid    = null;
  let callSid      = null;
  let openAiWs     = null;
  let callEnded    = false;
  let openAiReady  = false;
  let greetingDone = false; // prevent VAD interrupting the opening greeting
  let phone        = 'unknown';
  let revaClient   = null;
  const transcript  = [];
  const audioQueue  = []; // buffer while OpenAI is connecting

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
    const ulaw  = Buffer.from(base64mulaw, 'base64');
    const pcm8  = mulawToPcm16(ulaw);
    const pcm24 = upsample8to24(pcm8);
    openAiWs.send(JSON.stringify({
      type:  'input_audio_buffer.append',
      audio: pcm24.toString('base64'),
    }));
  }

  function sendToTwilio(base64pcm24) {
    if (!streamSid) return;
    const pcm24 = Buffer.from(base64pcm24, 'base64');
    const pcm8  = downsample24to8(pcm24);
    const ulaw  = pcm16ToMulaw(pcm8);
    twilioWs.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: ulaw.toString('base64') },
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
        Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta':  'realtime=v1',
      },
    });

    openAiWs.on('open', () => {
      console.log(`[REALTIME] OpenAI connected for ${phone}`);

      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities:   ['text', 'audio'],
          instructions: getVoiceSystemPrompt(revaClient) +
            '\n\nOnly call update_lead() with information the customer has EXPLICITLY said out loud. Never assume, guess, or infer details. Never call update_lead() based on vague sounds like "mm", "yeah", "ok", "uh" — only on clear statements.\n\nIf you hear something unclear or a short vague sound, just say "sorry, didn\'t catch that — what\'s going on with the roof?" Never make up or guess what they might have said. Never mention you are using any tools.',
          voice:                     'coral',
          input_audio_format:        'pcm16',
          output_audio_format:       'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type:                'server_vad',
            threshold:           0.9,
            prefix_padding_ms:   500,
            silence_duration_ms: 1000,
          },
          tools: [{
            type:        'function',
            name:        'update_lead',
            description: 'Silently save customer info as you gather it on the call.',
            parameters: {
              type: 'object',
              properties: {
                name:                  { type: 'string' },
                address:               { type: 'string' },
                city:                  { type: 'string' },
                issue_type:            { type: 'string' },
                urgency:               { type: 'string', enum: ['emergency','urgent','normal','low'] },
                property_type:         { type: 'string', enum: ['residential','commercial'] },
                preferred_appointment: { type: 'string' },
                stage:                 { type: 'string', enum: ['new','contacted','qualified','appointment_set'] },
                priority:              { type: 'string', enum: ['high','normal','low'] },
                notes:                 { type: 'string' },
              },
            },
          }],
          tool_choice: 'auto',
        },
      }));
    });

    openAiWs.on('message', async (raw) => {
      try {
        const ev = JSON.parse(raw);
        switch (ev.type) {

          case 'session.updated':
            // Session ready — discard buffered audio (it's just connection noise)
            // then trigger the greeting
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
            // Mark greeting as done after first response completes
            if (!greetingDone) greetingDone = true;
            break;

          case 'response.audio.delta':
            if (ev.delta) sendToTwilio(ev.delta);
            break;

          case 'response.audio_transcript.done':
            if (ev.transcript) {
              transcript.push({ role: 'assistant', text: ev.transcript });
              console.log(`[REALTIME] AI: ${ev.transcript.slice(0, 80)}`);
              // Hang up after goodbye — wait 2s for audio to finish playing
              const closingPhrases = ['have a great day', 'goodbye', 'take care', 'bye', 'have a good one', 'talk soon', 'have a good day'];
              if (closingPhrases.some(p => ev.transcript.toLowerCase().includes(p))) {
                setTimeout(() => hangUp(), 2000);
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
    openAiWs.on('close', ()  => console.log('[REALTIME] OpenAI WS closed'));
  }

  // ── Lead update tool call ───────────────────────────────────────────────────

  async function handleLeadUpdate(ev) {
    try {
      const args = JSON.parse(ev.arguments || '{}');
      const prev = await leadsDb.findByPhone(phone);
      await leadsDb.update(phone, args);
      console.log(`[REALTIME] update_lead:`, args);

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
      const accidentalPhrases = ['wrong number', 'accident', 'accidental', 'meant to call', 'wrong person', 'my bad', 'oops'];
      const wasAccidental = transcript.some(m =>
        m.role === 'user' && accidentalPhrases.some(p => m.text.toLowerCase().includes(p))
      );
      if (wasAccidental) {
        console.log(`[REALTIME] Accidental call from ${phone} — skipping alert and SMS`);
        return;
      }

      const lead = await leadsDb.findByPhone(phone);
      if (!lead) return;

      for (const m of transcript) {
        await conversations.add(
          phone, 'voice',
          m.role === 'user' ? 'inbound' : 'outbound',
          m.text, lead.id
        ).catch(() => {});
      }

      const r = await leadsDb.findByPhone(phone);
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

      await alertOwner(
        `📞 NEW CALL LEAD — Call them back!\n` +
        `👤 Name: ${r.name || 'Unknown'}\n📞 Phone: ${phone}\n` +
        `📍 ${r.address || r.city || 'Not given'}\n` +
        `🔧 Issue: ${r.issue_type || '?'}\n` +
        `⚡ Urgency: ${r.urgency || 'Normal'}\n` +
        `🏡 Property: ${r.property_type || '?'}\n` +
        `📅 Appt: ${r.preferred_appointment || 'Not set'}\n` +
        `💬 Source: Phone call`,
        revaClient
      ).catch(console.error);

    } catch (err) {
      console.error('[REALTIME] saveCallAndAlert error:', err);
    }
  }
}

module.exports = { createRealtimeBridge };
