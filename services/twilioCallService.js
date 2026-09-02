/**
 * Twilio Voice helpers: dialer-inbound bridge (agent dials Twilio → webhook dials customer).
 */

const twilio = require("twilio");
const { getTwilioClient } = require("./twilioSmsService");

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

function getTwilioFromNumber() {
    const { from } = getTwilioClient();
    return from;
}

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

function getVoiceIncomingWebhookUrl() {
    const base = getPublicBaseUrl();
    if (!base) {
        const err = new Error(
            "PUBLIC_BASE_URL is required for dialer calling (Twilio voice webhook)."
        );
        err.code = "PUBLIC_BASE_URL_MISSING";
        throw err;
    }
    return `${base}/webhooks/twilio/voice/incoming`;
}

/**
 * Twilio calls this when the bridged customer leg ends (call completed / agent
 * hung up). Carries sessionId so the handler can close the exact call session.
 * Returns null when the base URL is unknown so callers can skip wiring it.
 */
function getVoiceStatusWebhookUrl(sessionId) {
    const base = getPublicBaseUrl();
    if (!base) return null;
    const suffix =
        sessionId != null ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return `${base}/webhooks/twilio/voice/status${suffix}`;
}

function sessionTtlMinutes() {
    const n = Number(process.env.PHONE_CALL_SESSION_TTL_MINUTES);
    if (Number.isFinite(n) && n >= 5 && n <= 180) return n;
    return 30;
}

/**
 * Validate X-Twilio-Signature against the configured public webhook URL.
 */
function validateVoiceSignatureForUrl(signature, params, url) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;

    // Controlled bypass for local automated tests only
    if (
        process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === "true" &&
        process.env.NODE_ENV !== "production"
    ) {
        return true;
    }

    if (!signature || !url) return false;

    return twilio.validateRequest(authToken, signature, url, params || {});
}

function validateIncomingVoiceSignature(signature, params) {
    return validateVoiceSignatureForUrl(
        signature,
        params,
        getVoiceIncomingWebhookUrl()
    );
}

/**
 * TwiML: connect caller to customer; customer sees Twilio From as caller ID.
 */
function buildConnectCustomerTwiml(customerPhoneE164, options = {}) {
    const timeout = Math.min(
        Math.max(Number(options.timeoutSeconds) || 30, 15),
        60
    );
    const from = getTwilioFromNumber();
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
        { voice: "alice" },
        "Connecting you to the customer now."
    );
    const dial = twiml.dial({
        callerId: from,
        timeout,
        answerOnBridge: true,
    });
    // Twilio pings the status callback across the call lifecycle so we can record
    // when the customer leg connected/ended and mark the session closed in real
    // time. "answered" gives us connectedAt; "completed" gives duration + outcome.
    const numberAttrs = {};
    if (options.statusCallbackUrl) {
        numberAttrs.statusCallback = options.statusCallbackUrl;
        numberAttrs.statusCallbackMethod = "POST";
        numberAttrs.statusCallbackEvent = "initiated ringing answered completed";
    }
    dial.number(numberAttrs, String(customerPhoneE164).trim());
    return twiml.toString();
}

function buildRejectTwiml(message) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
        { voice: "alice" },
        message || "This secure calling connection is unavailable."
    );
    twiml.hangup();
    return twiml.toString();
}

module.exports = {
    isVoiceEnabled,
    getTwilioFromNumber,
    getPublicBaseUrl,
    getVoiceIncomingWebhookUrl,
    getVoiceStatusWebhookUrl,
    sessionTtlMinutes,
    validateIncomingVoiceSignature,
    validateVoiceSignatureForUrl,
    buildConnectCustomerTwiml,
    buildRejectTwiml,
};
