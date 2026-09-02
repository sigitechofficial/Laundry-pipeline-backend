/**
 * Thin Twilio SMS wrapper. Credentials from env.
 */

function getTwilioClient() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !from) {
        const err = new Error(
            "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER."
        );
        err.code = "TWILIO_NOT_CONFIGURED";
        throw err;
    }

    // Lazy require so app boots even if package missing in some envs
    const twilio = require("twilio");
    return {
        client: twilio(accountSid, authToken),
        from: String(from).trim(),
    };
}

/**
 * Public base URL for Twilio callbacks. Kept inline (not imported from
 * twilioCallService) to avoid a circular require — twilioCallService already
 * requires this module.
 */
function getPublicBaseUrl() {
    const fromEnv = process.env.PUBLIC_BASE_URL;
    if (fromEnv && String(fromEnv).trim()) {
        return String(fromEnv).trim().replace(/\/$/, "");
    }
    if (process.env.NODE_ENV === "production") {
        return "https://prodlaundry.sigisolutions.net";
    }
    if (process.env.NODE_ENV === "test") {
        return "https://stagelaundry.sigisolutions.net";
    }
    return null;
}

/**
 * @param {{ to: string, body: string }} params
 * @returns {Promise<{ sid: string, status: string, to: string, from: string }>}
 */
async function sendSms({ to, body }) {
    const { client, from } = getTwilioClient();

    const payload = {
        to: String(to).trim(),
        from,
        body: String(body).trim(),
    };

    // Wire delivery status callbacks so booking_notifications reflect the final
    // delivered/undelivered/failed outcome (admin Notify logs). Only when the
    // public webhook URL is reachable.
    const base = getPublicBaseUrl();
    if (base) {
        payload.statusCallback = `${base}/webhooks/twilio/sms/status`;
    }

    const message = await client.messages.create(payload);

    return {
        sid: message.sid,
        status: message.status,
        to: message.to,
        from: message.from || from,
    };
}

module.exports = {
    sendSms,
    getTwilioClient,
    getPublicBaseUrl,
};
