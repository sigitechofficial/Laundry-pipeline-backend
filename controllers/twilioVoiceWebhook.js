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

    const customerPhone = normalizePhoneNumber(
        bookingRow.customer?.phoneNum,
        bookingRow.customer?.countryCode
    );
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
        const xml = twilioCallService.buildConnectCustomerTwiml(customerPhone);
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
