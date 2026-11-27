/**
 * Twilio status webhook for automatic WhatsApp messages (public, signature-validated).
 * Updates the whatsappMessages row by MessageSid: sent -> delivered -> read, or
 * failed / undelivered with Twilio's error code.
 */

const twilioCallService = require("../services/twilioCallService");
const { whatsappMessage } = require("../models");

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
