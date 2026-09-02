/**
 * Twilio Messaging status webhook (public, signature-validated).
 *
 * Twilio calls this per SMS as it progresses (sent -> delivered / undelivered /
 * failed). We update the matching booking_notifications row by MessageSid so the
 * admin Notify / Call logs reflect the final delivery outcome instead of only
 * the send-time status.
 */

const twilioCallService = require("../services/twilioCallService");
const { bookingNotification } = require("../models");

exports.smsStatus = async (req, res) => {
    const signature = req.get("X-Twilio-Signature");
    const params = req.body || {};

    const base = twilioCallService.getPublicBaseUrl();
    const fullUrl = base ? `${base}${req.originalUrl}` : null;

    try {
        if (
            !twilioCallService.validateVoiceSignatureForUrl(
                signature,
                params,
                fullUrl
            )
        ) {
            console.warn("[twilioSms] status: invalid or missing signature");
            // Always ACK Twilio (avoid retries); do not mutate state.
            return res.status(204).end();
        }
    } catch (err) {
        console.error("[twilioSms] status signature error:", err.message);
        return res.status(204).end();
    }

    const messageSid = params.MessageSid || params.SmsSid || null;
    const messageStatus = String(params.MessageStatus || params.SmsStatus || "")
        .toLowerCase()
        .trim();

    if (!messageSid || !messageStatus) {
        return res.status(204).end();
    }

    try {
        const row = await bookingNotification.findOne({
            where: { twilioSid: String(messageSid).trim() },
            order: [["id", "DESC"]],
        });

        if (row) {
            const updates = { twilioStatus: messageStatus };
            if (messageStatus === "delivered" && !row.deliveredAt) {
                updates.deliveredAt = new Date();
            }
            await row.update(updates);
        }
    } catch (err) {
        console.error("[twilioSms] status update error:", err.message);
    }

    return res.status(204).end();
};
