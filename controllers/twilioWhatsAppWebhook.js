/**
 * Twilio status webhook for automatic WhatsApp messages (public, signature-validated).
 * Updates the whatsappMessages row by MessageSid: sent -> delivered -> read, or
 * failed / undelivered with Twilio's error code.
 */

const twilioCallService = require("../services/twilioCallService");
const { whatsappMessage } = require("../models");
const whatsappService = require("../services/whatsappService");

function xmlEscape(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function twiml(res, message) {
    const body = message ? `<Message>${xmlEscape(message)}</Message>` : "";
    return res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

/**
 * Incoming WhatsApp message from a customer (the sender's "when a message comes
 * in" webhook). The number only sends order updates, so answer with the
 * auto-reply (call centre number + app), at most once per number every 12 hours.
 */
exports.whatsappIncoming = async (req, res) => {
    const signature = req.get("X-Twilio-Signature");
    const params = req.body || {};
    const base = twilioCallService.getPublicBaseUrl();
    const fullUrl = base ? `${base}${req.originalUrl}` : null;

    try {
        if (!twilioCallService.validateVoiceSignatureForUrl(signature, params, fullUrl)) {
            console.warn("[twilioWhatsApp] incoming: invalid or missing signature");
            return twiml(res, null);
        }
    } catch (err) {
        console.error("[twilioWhatsApp] incoming signature error:", err.message);
        return twiml(res, null);
    }

    const reply = await whatsappService.autoReplyFor(params.From);
    return twiml(res, reply);
};

const FINAL_ORDER = ["queued", "accepted", "sending", "sent", "delivered", "read"];

exports.whatsappStatus = async (req, res) => {
    const signature = req.get("X-Twilio-Signature");
    const params = req.body || {};
    const base = twilioCallService.getPublicBaseUrl();
    const fullUrl = base ? `${base}${req.originalUrl}` : null;

    try {
        if (!twilioCallService.validateVoiceSignatureForUrl(signature, params, fullUrl)) {
            console.warn("[twilioWhatsApp] status: invalid or missing signature");
            return res.status(204).end();
        }
    } catch (err) {
        console.error("[twilioWhatsApp] status signature error:", err.message);
        return res.status(204).end();
    }

    const sid = params.MessageSid || params.SmsSid || null;
    const status = String(params.MessageStatus || params.SmsStatus || "").toLowerCase().trim();
    if (!sid || !status) return res.status(204).end();

    try {
        const row = await whatsappMessage.findOne({ where: { twilioSid: String(sid).trim() } });
        if (row) {
            // Callbacks can arrive out of order: never step back from read to delivered.
            const was = FINAL_ORDER.indexOf(row.status);
            const now = FINAL_ORDER.indexOf(status);
            if (!(was >= 0 && now >= 0 && now < was)) {
                const updates = { status: status.slice(0, 24) };
                if ((status === "delivered" || status === "read") && !row.deliveredAt) updates.deliveredAt = new Date();
                if (params.ErrorCode) {
                    updates.error = `${params.ErrorCode}: ${params.ErrorMessage || "Twilio error"}`.slice(0, 255);
                }
                await row.update(updates);
            }
        }
    } catch (err) {
        console.error("[twilioWhatsApp] status update error:", err.message);
    }
    return res.status(204).end();
};
