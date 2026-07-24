/**
 * Twilio Voice: click-to-call (ring agent, then dial customer).
 * Uses inline TwiML so no public webhook URL is required.
 */

const { getTwilioClient } = require("./twilioSmsService");

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Kill switch for voice only (SMS unaffected).
 * Default ON. Set TWILIO_VOICE_ENABLED=false|0|off to disable.
 */
function isVoiceEnabled() {
    const raw = process.env.TWILIO_VOICE_ENABLED;
    if (raw == null || String(raw).trim() === "") return true;
    const value = String(raw).trim().toLowerCase();
    return !(
        value === "false" ||
        value === "0" ||
        value === "off" ||
        value === "no"
    );
}

/**
 * Ring agentPhone first; when answered, dial customerPhone.
 * Customer sees TWILIO_PHONE_NUMBER as caller ID.
 *
 * @param {{ agentPhone: string, customerPhone: string, timeoutSeconds?: number }} params
 * @returns {Promise<{ sid: string, status: string, to: string, from: string }>}
 */
async function startClickToCall({
    agentPhone,
    customerPhone,
    timeoutSeconds = 30,
}) {
    if (!isVoiceEnabled()) {
        const err = new Error(
            "Twilio voice calling is disabled (TWILIO_VOICE_ENABLED=false)."
        );
        err.code = "TWILIO_VOICE_DISABLED";
        throw err;
    }

    const { client, from } = getTwilioClient();
    const toAgent = String(agentPhone).trim();
    const toCustomer = String(customerPhone).trim();
    const dialTimeout = Math.min(
        Math.max(Number(timeoutSeconds) || 30, 15),
        60
    );

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to the customer now.</Say>
  <Dial callerId="${escapeXml(from)}" timeout="${dialTimeout}">${escapeXml(
        toCustomer
    )}</Dial>
</Response>`;

    const call = await client.calls.create({
        to: toAgent,
        from,
        twiml,
    });

    return {
        sid: call.sid,
        status: call.status,
        to: call.to,
        from: call.from || from,
    };
}

module.exports = {
    startClickToCall,
    isVoiceEnabled,
};
