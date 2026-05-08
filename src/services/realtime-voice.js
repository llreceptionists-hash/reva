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
            (() => {
              const tz  = process.env.TIMEZONE || 'America/Vancouver';
              const now = new Date().toLocaleString('en-US', {
                timeZone: tz, weekday: 'long', year: 'numeric',
                month: 'long', day: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true,
              });
              return `\n\nCURRENT DATE & TIME: ${now} (${tz}). Use this when discussing availability or appointment times. Never suggest a time that has already passed today.`;
            })() +
            '\n\nCRITICAL — ONLY use information from THIS call:\n- Never assume you already know the customer\'s name, address, or any details\n- Never say things like "oh I know your name" or "I have your info" unless they explicitly told you that on this exact call\n- If you have not been told something, you do not know it — ask for it naturally\n- Do not book or confirm an appointment unless the customer has explicitly agreed to a specific time on this call\n- If you hear silence or cannot understand what was said, just say "hey sorry, didn\'t quite catch that — what\'s going on with the roof?"\n\nupdate_lead() rules:\n- Call it every time the customer gives ANY new info — name, address, issue, appointment, property type\n- Call it AGAIN immediately whenever the customer corrects or changes something — even if you already saved it\n- For issue_type: always save the customer\'s EXACT words. Never paraphrase. "hole in my roof" stays "hole in my roof", not "small repair"\n- Never call update_lead() based on vague sounds like "mm", "yeah", "ok" — only on clear explicit statements\n\nNever mention you are using any tools.',
          voice:                     'coral',
          input_audio_format:        'pcm16',
          output_audio_format:       'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type:                'server_vad',
            threshold:           0.95,
            prefix_padding_ms:   500,
            silence_duration_ms: 1200,
          },
          tools: [{
            type:        'function',
            name:        'update_lead',
            description: 'Silently save customer info as you gather it on the call. Call this every time any piece of info is first given OR corrected — including if the customer changes their appointment time, address, or any other detail. Always save the customer\'s exact words for issue_type, do not paraphrase or interpret (e.g. save "hole in my roof" not "small repair").',
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
      // (e.g. someone called to check the number then hung up)
      const userMessages = transcript.filter(m => m.role === 'user');
      const nothingCaptured = !lead.name && !lead.issue_type && !lead.address && !lead.city;
      if (userMessages.length <= 1 && nothingCaptured) {
        console.log(`[REALTIME] No info captured from ${phone} — skipping alert and SMS`);
        return;
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
