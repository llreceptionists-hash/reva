'use strict';

/**
 * GPT-4o Realtime API bridge for Twilio Media Streams.
 *
 * Flow:
 *   Twilio call → <Connect><Stream> → WebSocket → this module
 *   Audio in:  mulaw 8 kHz  →  PCM-16 24 kHz  →  OpenAI Realtime
 *   Audio out: PCM-16 24 kHz →  mulaw 8 kHz   →  Twilio
 *
 * Result: ~300 ms end-to-end latency with natural interruption handling.
 */

const WebSocket = require('ws');
const { leads: leadsDb, conversations } = require('../db/leads');
const { alertOwner, sendSms }          = require('./sms');
const { getVoiceSystemPrompt }         = require('../prompts/system');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

// ── Audio conversion ─────────────────────────────────────────────────────────

// Pre-built µ-law → PCM-16 decode table
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

// 8 kHz → 24 kHz: 3× linear interpolation
function upsample8to24(buf) {
  const n   = buf.length >> 1;
  const out = Buffer.alloc(n * 6);
  for (let i = 0; i < n; i++) {
    const s0 = buf.readInt16LE(i * 2);
    const s1 = (i + 1 < n) ? buf.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0,                                     i * 6);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) / 3),        i * 6 + 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * 2 / 3),    i * 6 + 4);
  }
  return out;
}

// 24 kHz → 8 kHz: take every 3rd sample
function downsample24to8(buf) {
  const n   = Math.floor((buf.length >> 1) / 3);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(buf.readInt16LE(i * 6), i * 2);
  return out;
}

// ── Bridge ───────────────────────────────────────────────────────────────────

function createRealtimeBridge(twilioWs, phone, revaClient) {
  let streamSid = null;
  let callEnded = false;
  const transcript = []; // { role, text }

  if (!process.env.OPENAI_API_KEY) {
    console.error('[REALTIME] OPENAI_API_KEY not set — cannot start realtime bridge');
    twilioWs.close();
    return;
  }

  const openAiWs = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization:   `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta':   'realtime=v1',
    },
  });

  // ── OpenAI → us ──────────────────────────────────────────────────────────

  openAiWs.on('open', () => {
    console.log(`[REALTIME] OpenAI connected for ${phone}`);

    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities:   ['text', 'audio'],
        instructions: getVoiceSystemPrompt(revaClient) +
          '\n\nAs you collect information during the call, silently call update_lead() to save it. ' +
          'Never mention you are saving info or using any tools.',
        voice:                   'alloy',
        input_audio_format:      'pcm16',
        output_audio_format:     'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type:                'server_vad',
          threshold:           0.5,
          prefix_padding_ms:   300,
          silence_duration_ms: 600,
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

        // Session configured → trigger greeting
        case 'session.updated':
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type:    'message',
              role:    'user',
              content: [{ type: 'input_text', text: '(call just connected — greet the customer)' }],
            },
          }));
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
          break;

        // User started talking — clear buffered AI audio so interruptions feel natural
        case 'input_audio_buffer.speech_started':
          if (streamSid) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          break;

        // Stream AI audio back to Twilio
        case 'response.audio.delta':
          if (streamSid && ev.delta) {
            const pcm24 = Buffer.from(ev.delta, 'base64');
            const pcm8  = downsample24to8(pcm24);
            const ulaw  = pcm16ToMulaw(pcm8);
            twilioWs.send(JSON.stringify({
              event:    'media',
              streamSid,
              media:    { payload: ulaw.toString('base64') },
            }));
          }
          break;

        // Save what AI said
        case 'response.audio_transcript.done':
          if (ev.transcript) {
            transcript.push({ role: 'assistant', text: ev.transcript });
            console.log(`[REALTIME] AI: ${ev.transcript.slice(0, 80)}`);
          }
          break;

        // Save what user said
        case 'conversation.item.input_audio_transcription.completed':
          if (ev.transcript) {
            transcript.push({ role: 'user', text: ev.transcript });
            console.log(`[REALTIME] User: ${ev.transcript.slice(0, 80)}`);
          }
          break;

        // Handle lead update tool calls
        case 'response.function_call_arguments.done':
          if (ev.name === 'update_lead') {
            await handleLeadUpdate(ev);
          }
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

  // ── Twilio → us ──────────────────────────────────────────────────────────

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          console.log(`[REALTIME] Stream SID: ${streamSid} for ${phone}`);
          break;

        case 'media':
          if (openAiWs.readyState === WebSocket.OPEN) {
            const ulaw  = Buffer.from(msg.media.payload, 'base64');
            const pcm8  = mulawToPcm16(ulaw);
            const pcm24 = upsample8to24(pcm8);
            openAiWs.send(JSON.stringify({
              type:  'input_audio_buffer.append',
              audio: pcm24.toString('base64'),
            }));
          }
          break;

        case 'stop':
          endCall();
          break;
      }
    } catch (err) {
      console.error('[REALTIME] Twilio message error:', err);
    }
  });

  twilioWs.on('close', () => endCall());
  twilioWs.on('error', (err) => console.error('[REALTIME] Twilio WS error:', err.message));

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function handleLeadUpdate(ev) {
    try {
      const args = JSON.parse(ev.arguments || '{}');
      const prev = await leadsDb.findByPhone(phone);
      await leadsDb.update(phone, args);
      console.log(`[REALTIME] Lead updated:`, args);

      // Send function output so AI continues
      openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true}' },
      }));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));

      // Alert owner when appointment is first set or changes
      if (args.preferred_appointment && args.preferred_appointment !== prev?.preferred_appointment) {
        const r = await leadsDb.findByPhone(phone);
        await alertOwner(
          `📞 NEW CALL LEAD — Appointment set!\n` +
          `👤 Name: ${r?.name || 'Unknown'}\n` +
          `📞 Phone: ${phone}\n` +
          `📍 ${r?.address || r?.city || 'Address TBD'}\n` +
          `🔧 Issue: ${r?.issue_type || 'Not specified'}\n` +
          `📅 Appt: ${args.preferred_appointment}\n` +
          `💬 Source: Phone call`,
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

  function endCall() {
    if (callEnded) return;
    callEnded = true;
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    saveCallAndAlert().catch(console.error);
  }

  async function saveCallAndAlert() {
    if (!transcript.length) return;
    try {
      const lead = await leadsDb.findByPhone(phone);
      if (!lead) return;

      // Persist full transcript
      for (const m of transcript) {
        await conversations.add(
          phone, 'voice',
          m.role === 'user' ? 'inbound' : 'outbound',
          m.text, lead.id
        ).catch(() => {});
      }

      const r = await leadsDb.findByPhone(phone);
      if (!r) return;

      // Summary SMS to customer
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

      // Alert owner with full lead details
      await alertOwner(
        `📞 NEW CALL LEAD — Call them back!\n` +
        `👤 Name: ${r.name || 'Unknown'}\n` +
        `📞 Phone: ${phone}\n` +
        `📍 ${r.address || r.city || 'Not given'}\n` +
        `🔧 Issue: ${r.issue_type || 'Not specified'}\n` +
        `⚡ Urgency: ${r.urgency || 'Normal'}\n` +
        `🏡 Property: ${r.property_type || 'Unknown'}\n` +
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
