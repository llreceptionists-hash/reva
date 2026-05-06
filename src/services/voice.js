'use strict';

const twilio = require('twilio');
const { VoiceResponse } = twilio.twiml;

const BASE_URL = process.env.BASE_URL || 'https://yourdomain.com';

function getVoice(revaClient) {
  return revaClient?.voice || process.env.TWILIO_VOICE || 'Polly.Joanna-Neural';
}

// Friendlier greeting with more natural pacing


function buildGreetTwiml(sessionId, revaClient = null) {
  const resp   = new VoiceResponse();
  const voice  = getVoice(revaClient);
  const company = revaClient?.company_name || process.env.COMPANY_NAME || 'us';

  const gather = resp.gather({
    input: 'speech',
    action: `${BASE_URL}/twilio/voice/respond?session=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });
  gather.say({ voice },
    `Hey, thanks for calling ${company}! This is Reva. What can I help you with today?`
  );
  resp.redirect({ method: 'POST' }, `${BASE_URL}/twilio/voice/respond?session=${sessionId}&fallback=1`);
  return resp.toString();
}

function buildSpeakAndGatherTwiml(text, sessionId, turnCount = 0, revaClient = null) {
  const resp  = new VoiceResponse();
  const voice = getVoice(revaClient);

  const gather = resp.gather({
    input: 'speech',
    action: `${BASE_URL}/twilio/voice/respond?session=${sessionId}&turn=${turnCount + 1}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });
  gather.say({ voice }, text);
  resp.redirect({ method: 'POST' },
    `${BASE_URL}/twilio/voice/respond?session=${sessionId}&turn=${turnCount + 1}&fallback=1`
  );
  return resp.toString();
}

function buildClosingTwiml(text, revaClient = null) {
  const resp  = new VoiceResponse();
  const voice = getVoice(revaClient);
  resp.say({ voice }, text);
  resp.hangup();
  return resp.toString();
}

function buildForwardTwiml(message, revaClient = null) {
  const resp      = new VoiceResponse();
  const voice     = getVoice(revaClient);
  const forwardTo = revaClient?.forward_phone || process.env.FORWARD_PHONE;

  if (message) resp.say({ voice }, message);
  if (forwardTo) {
    resp.dial(forwardTo);
  } else {
    resp.say({ voice }, `Please hold while I connect you with our team.`);
    resp.hangup();
  }
  return resp.toString();
}

function buildVoicemailTwiml(revaClient = null) {
  const resp  = new VoiceResponse();
  const voice = getVoice(revaClient);
  resp.say({ voice },
    `Sorry, all of our team members are currently unavailable. ` +
    `Please leave a message after the tone and we'll call you back shortly.`
  );
  resp.record({
    action:              `${BASE_URL}/twilio/voice/voicemail`,
    method:              'POST',
    maxLength:           120,
    transcribe:          true,
    transcribeCallback:  `${BASE_URL}/twilio/voice/transcription`,
  });
  return resp.toString();
}

module.exports = {
  buildGreetTwiml,
  buildSpeakAndGatherTwiml,
  buildClosingTwiml,
  buildForwardTwiml,
  buildVoicemailTwiml,
};
