'use strict';

const axios = require('axios');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID   = process.env.ELEVENLABS_VOICE_ID || 'kdmDKE6EkgrWrrykO9Qt';

/**
 * Convert text to speech using ElevenLabs.
 * Returns a Buffer of MP3 audio.
 */
async function textToSpeech(text, voiceId = DEFAULT_VOICE_ID) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.80,
        style: 0.35,
        use_speaker_boost: true
      }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      responseType: 'arraybuffer',
      timeout: 10000
    }
  );

  return Buffer.from(response.data);
}

module.exports = { textToSpeech };
