'use strict';

const twilio = require('twilio');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send an outbound SMS from a specific number.
 */
async function sendSms(to, body, from = process.env.TWILIO_PHONE_NUMBER) {
  try {
    const msg = await twilioClient.messages.create({ from, to, body });
    console.log(`[SMS] Sent to ${to}: ${body.slice(0, 60)}... [SID: ${msg.sid}]`);
    return msg;
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err.message);
    throw err;
  }
}

/**
 * Alert the owner of a specific client.
 */
async function alertOwner(message, client = null) {
  const ownerPhone = client?.owner_phone || process.env.OWNER_PHONE;
  const fromPhone  = client?.phone_number || process.env.TWILIO_PHONE_NUMBER;
  if (!ownerPhone) return;
  return sendSms(ownerPhone, `🔔 REVA ALERT: ${message}`, fromPhone);
}

module.exports = { sendSms, alertOwner };
