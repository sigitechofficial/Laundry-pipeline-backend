/**
 * Twilio Voice webhooks (public, signature-validated).
 */

const twilioCallService = require("../services/twilioCallService");
const {
    bookingCallSession,
    booking,
    users,
} = require("../models");
const {
    normalizePhoneNumber,
    resolveCustomerE164,
} = require("../services/Agent/customerNotifyService");
const { Op } = require("sequelize");

function sendTwiml(res, xml) {
    res.type("text/xml");
    return res.status(200).send(xml);
}

/**
 * POST /webhooks/twilio/voice/incoming
 * Agent dialed Twilio number → bridge to customer from active call session.
 */
exports.voiceIncoming = async (req, res) => {
    const signature = req.get("X-Twilio-Signature");
    const params = req.body || {};

    try {
        if (!twilioCallService.validateIncomingVoiceSignature(signature, params)) {
            console.warn("[twilioVoice] invalid or missing signature");
            return sendTwiml(
                res,
                twilioCallService.buildRejectTwiml(
                    "This secure calling connection is unavailable."
                )
            );
        }
    } catch (err) {
        console.error("[twilioVoice] signature/config error:", err.message);
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    if (!twilioCallService.isVoiceEnabled()) {
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "Calling is temporarily unavailable."
            )
        );
    }

    const fromRaw = params.From;
    const toRaw = params.To;
    const expectedTo = twilioCallService.getTwilioFromNumber();

    const toNormalized = normalizePhoneNumber(toRaw, null);
    const expectedNormalized = normalizePhoneNumber(expectedTo, null);
    if (
        toNormalized &&
        expectedNormalized &&
        toNormalized !== expectedNormalized
    ) {
        console.warn("[twilioVoice] unexpected To number", toRaw);
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    const agentPhone = normalizePhoneNumber(fromRaw, null);
    if (!agentPhone) {
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    const now = new Date();
    const session = await bookingCallSession.findOne({
        where: {
            agentPhoneE164: agentPhone,
            status: "active",
            expiresAt: { [Op.gt]: now },
        },
        order: [["id", "DESC"]],
    });

    if (!session) {
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    const bookingRow = await booking.findOne({
        where: { id: session.bookingId },
        attributes: ["id", "customerId", "bookingStatusId", "laundryShopId"],
        include: [
            {
                model: users,
                as: "customer",
                attributes: ["id", "phoneNum", "countryCode"],
                required: false,
            },
        ],
    });

    if (!bookingRow) {
        await session.update({
            status: "closed",
            closedAt: now,
            closeReason: "booking_missing",
        });
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    const customerPhone = await resolveCustomerE164(bookingRow);
    if (!customerPhone) {
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    if (customerPhone === agentPhone) {
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }

    try {
        const statusCallbackUrl = twilioCallService.getVoiceStatusWebhookUrl(
            session.id
        );
        const xml = twilioCallService.buildConnectCustomerTwiml(customerPhone, {
            statusCallbackUrl,
        });
        return sendTwiml(res, xml);
    } catch (err) {
        console.error("[twilioVoice] twiml error:", err.message);
        return sendTwiml(
            res,
            twilioCallService.buildRejectTwiml(
                "This secure calling connection is unavailable."
            )
        );
    }
};

/**
 * POST /webhooks/twilio/voice/status?sessionId=:id
 * Twilio dial status callback — fired when the bridged customer leg ends.
 * Closes the matching active call session so the admin panel stops showing it
 * as "Active" after the agent ends the call.
 */
exports.voiceStatus = async (req, res) => {
    const signature = req.get("X-Twilio-Signature");
    const params = req.body || {};

    // Twilio signs the exact status callback URL, including the query string.
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
            console.warn("[twilioVoice] status: invalid or missing signature");
            // Always ACK Twilio (avoid retries); do not mutate state.
            return res.status(204).end();
        }
    } catch (err) {
        console.error("[twilioVoice] status signature error:", err.message);
        return res.status(204).end();
    }

    const now = new Date();
    const sessionId = req.query?.sessionId;
    const callStatus = String(params.CallStatus || params.DialCallStatus || "")
        .toLowerCase()
        .trim();
    const callSid = params.CallSid ? String(params.CallSid).trim() : null;
    const durationRaw = params.DialCallDuration || params.CallDuration;
    const callDurationSec =
        durationRaw != null && String(durationRaw).trim() !== "" && !Number.isNaN(Number(durationRaw))
            ? Math.max(0, Math.trunc(Number(durationRaw)))
            : null;

    // "answered" / "in-progress" mark the moment the customer leg connected.
    const connectedStates = ["answered", "in-progress"];
    const isConnected = connectedStates.includes(callStatus);

    // Terminal states for a leg — any of these means the call is over.
    const terminalStates = [
        "completed",
        "busy",
        "no-answer",
        "canceled",
        "failed",
    ];
    const isTerminal = !callStatus || terminalStates.includes(callStatus);

    try {
        let session = null;
        if (sessionId != null && String(sessionId).trim() !== "") {
            session = await bookingCallSession.findByPk(Number(sessionId));
        }

        // Fallback: resolve by agent phone (parent leg From) when id missing.
        if (!session) {
            const agentPhone = normalizePhoneNumber(params.From, null);
            if (agentPhone) {
                session = await bookingCallSession.findOne({
                    where: { agentPhoneE164: agentPhone, status: "active" },
                    order: [["id", "DESC"]],
                });
            }
        }

        if (session) {
            const updates = {};
            if (callSid && !session.callSid) updates.callSid = callSid;
            if (callStatus) updates.callStatus = callStatus;
            if (callDurationSec != null) updates.callDurationSec = callDurationSec;
            if (isConnected && !session.connectedAt) updates.connectedAt = now;

            if (isTerminal) {
                if (!session.endedAt) updates.endedAt = now;
                // Only flip an active session to closed on a terminal ping;
                // never re-open an already closed/expired one.
                if (session.status === "active") {
                    updates.status = "closed";
                    updates.closedAt = now;
                    updates.closeReason = callStatus
                        ? `call_${callStatus.replace(/-/g, "_")}`
                        : "call_completed";
                }
            }

            if (Object.keys(updates).length > 0) {
                await session.update(updates);
            }
        }
    } catch (err) {
        console.error("[twilioVoice] status update error:", err.message);
    }

    return res.status(204).end();
};
