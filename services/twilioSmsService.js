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
 * @param {{ to: string, body: string }} params
 * @returns {Promise<{ sid: string, status: string, to: string, from: string }>}
 */
async function sendSms({ to, body }) {
    const { client, from } = getTwilioClient();
    const message = await client.messages.create({
        to: String(to).trim(),
        from,
        body: String(body).trim(),
    });

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
};
