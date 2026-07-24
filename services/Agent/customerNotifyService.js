/**
 * Agent → customer SMS / click-to-call (Twilio) when reached for pickup / delivery.
 */

const { booking, users, addressDb, bookingAttempt, bookingNotification } = require("../../models");
const { Op } = require("sequelize");
const {
    ValidationError,
    NotFoundError,
    ForbiddenError,
    TooManyRequestsError,
    UniversalHttpError,
} = require("../../middlewares/universalErrorHandler");
const {
    assertBookingNotCancelledForAgent,
} = require("../../utils/assertBookingNotCancelledForAgent");
const twilioSmsService = require("../twilioSmsService");
const twilioCallService = require("../twilioCallService");
const { maskPhoneNumber } = require("../../utils/maskPhone");
const { sendNotification } = require("../../utils/notification");

const RATE_LIMIT_MS = 2 * 60 * 1000;
/** Push notifies before SMS is used for the same booking+leg */
const PUSH_ATTEMPTS_BEFORE_SMS = 3;
/** @type {Map<string, number>} */
const recentNotifyByKey = new Map();

const TEMPLATES = {
    arrived_pickup:
        "Hi {name}, your driver has arrived for laundry pickup. Order {orderTrackId}. — Just Dry Cleans",
    arrived_delivery:
        "Hi {name}, your driver has arrived to deliver your laundry. Order {orderTrackId}. — Just Dry Cleans",
};

const PUSH_TITLES = {
    pickup: "Driver arrived for pickup",
    delivery: "Driver arrived for delivery",
};

const PICKUP_STATUS_IDS = new Set([5, 6]);
const DELIVERY_STATUS_IDS = new Set([13, 14]);

function normalizeLeg(leg) {
    const value = String(leg || "")
        .toLowerCase()
        .trim();
    if (value === "pickup" || value === "pick_up" || value === "collection") {
        return "pickup";
    }
    if (value === "delivery" || value === "dropoff" || value === "drop_off") {
        return "delivery";
    }
    return null;
}

function normalizeChannel(channel) {
    const value = String(channel || "sms")
        .toLowerCase()
        .trim();
    if (value === "sms" || value === "call") return value;
    return null;
}

/**
 * Map users.countryCode (+44 / 44 / GB / PK / +92) → dial prefix like "+44".
 */
function normalizeCountryDialCode(rawCountryCode) {
    if (rawCountryCode == null) return null;
    let code = String(rawCountryCode).trim().replace(/[\s()-]/g, "");
    if (!code) return null;

    const upper = code.toUpperCase();
    if (upper === "GB" || upper === "UK") return "+44";
    if (upper === "PK") return "+92";

    if (code.startsWith("00")) {
        code = `+${code.slice(2)}`;
    }
    if (!code.startsWith("+")) {
        if (/^\d{1,4}$/.test(code)) {
            code = `+${code}`;
        } else {
            return null;
        }
    }

    if (!/^\+[1-9]\d{0,3}$/.test(code)) {
        return null;
    }
    return code;
}

/**
 * Build E.164 from users.phoneNum + users.countryCode.
 * Prefer full international phoneNum; otherwise prepend countryCode.
 */
function normalizePhoneNumber(rawPhone, rawCountryCode = null) {
    if (rawPhone == null) return null;
    let phone = String(rawPhone).trim().replace(/[\s()-]/g, "");
    if (!phone) return null;

    if (phone.startsWith("00")) {
        phone = `+${phone.slice(2)}`;
    }

    // Already E.164
    if (phone.startsWith("+")) {
        return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
    }

    const dial = normalizeCountryDialCode(rawCountryCode);
    const dialDigits = dial ? dial.slice(1) : null;

    // National number already includes country digits (92300… / 4477…)
    if (
        dialDigits &&
        phone.startsWith(dialDigits) &&
        phone.length > dialDigits.length + 6
    ) {
        phone = `+${phone}`;
    } else if (dial) {
        // Strip leading 0 from national format (07… / 03…)
        const national = phone.startsWith("0") ? phone.slice(1) : phone;
        if (!/^\d{6,14}$/.test(national)) {
            return null;
        }
        phone = `${dial}${national}`;
    } else if (phone.startsWith("44") || phone.startsWith("92")) {
        phone = `+${phone}`;
    } else if (phone.startsWith("07") && phone.length >= 10) {
        // UK mobile without countryCode
        phone = `+44${phone.slice(1)}`;
    } else if (phone.startsWith("03") && phone.length >= 10) {
        // Pakistan mobile without countryCode
        phone = `+92${phone.slice(1)}`;
    } else {
        return null;
    }

    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        return null;
    }
    return phone;
}

function maskPhone(phone) {
    return maskPhoneNumber(phone) || "***";
}

function fillTemplate(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (_, key) => {
        const value = vars[key];
        return value != null && value !== "" ? String(value) : "";
    });
}

function defaultTemplateKey(leg) {
    return leg === "delivery" ? "arrived_delivery" : "arrived_pickup";
}

function assertRateLimit(bookingId, leg, channel) {
    const key = `${bookingId}:${leg}:${channel}`;
    const now = Date.now();
    const last = recentNotifyByKey.get(key) || 0;
    if (now - last < RATE_LIMIT_MS) {
        const waitSec = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        throw new TooManyRequestsError(
            `Please wait ${waitSec}s before another ${channel} for this ${leg}.`
        );
    }
    if (recentNotifyByKey.size > 500) {
        for (const [k, ts] of recentNotifyByKey) {
            if (now - ts > RATE_LIMIT_MS) recentNotifyByKey.delete(k);
        }
    }
    recentNotifyByKey.set(key, now);
}

function clearRateLimit(bookingId, leg, channel) {
    recentNotifyByKey.delete(`${bookingId}:${leg}:${channel}`);
}

async function resolveAgentShopId(agentUserId) {
    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["id"],
    });
    return shop?.id || null;
}

async function loadOpenAttempt(bookingId, leg) {
    return bookingAttempt.findOne({
        where: {
            bookingId,
            attemptType: leg,
            status: "arrived",
        },
        order: [["id", "DESC"]],
        attributes: ["id"],
    });
}

async function logNotification(payload) {
    try {
        const row = await bookingNotification.create(payload);
        return row.id;
    } catch (logErr) {
        console.error(
            `[customerNotify] failed to log ${payload.channel} for booking ${payload.bookingId}:`,
            logErr.message
        );
        return null;
    }
}

/**
 * @param {object} params
 * @param {number|string} params.bookingId
 * @param {number} params.agentUserId
 * @param {string} params.leg - pickup | delivery
 * @param {string} [params.channel] - sms | call
 */
async function notifyCustomer({
    bookingId,
    agentUserId,
    leg: rawLeg,
    channel = "sms",
}) {
    const leg = normalizeLeg(rawLeg);
    if (!leg) {
        throw new ValidationError('leg must be "pickup" or "delivery"');
    }

    const normalizedChannel = normalizeChannel(channel);
    if (!normalizedChannel) {
        throw new ValidationError('channel must be "sms" or "call"');
    }

    const bookingRow = await booking.findOne({
        where: { id: bookingId },
        attributes: [
            "id",
            "orderTrackId",
            "bookingStatusId",
            "laundryShopId",
            "customerId",
            "driverId",
            "deliveryDriverId",
        ],
        include: [
            {
                model: users,
                as: "customer",
                attributes: [
                    "id",
                    "firstName",
                    "lastName",
                    "phoneNum",
                    "countryCode",
                ],
                required: false,
            },
        ],
    });

    if (!bookingRow) {
        throw new NotFoundError(`Booking with ID ${bookingId} not found`);
    }

    assertBookingNotCancelledForAgent(bookingRow);

    const shopId = await resolveAgentShopId(agentUserId);
    if (!shopId || Number(bookingRow.laundryShopId) !== Number(shopId)) {
        throw new ForbiddenError("You are not assigned to this booking");
    }

    const statusId = Number(bookingRow.bookingStatusId);
    if (leg === "pickup" && !PICKUP_STATUS_IDS.has(statusId)) {
        throw new ValidationError(
            "Notify for pickup is only allowed after driver reached pickup (status 5)."
        );
    }
    if (leg === "delivery" && !DELIVERY_STATUS_IDS.has(statusId)) {
        throw new ValidationError(
            "Notify for delivery is only allowed when out for delivery or driver reached (status 13–14)."
        );
    }

    const customerPhone = normalizePhoneNumber(
        bookingRow.customer?.phoneNum,
        bookingRow.customer?.countryCode
    );
    if (!customerPhone) {
        throw new ValidationError(
            "Customer phone number is missing or invalid. Cannot notify customer."
        );
    }

    if (normalizedChannel === "sms") {
        return sendNotifyLadder({
            bookingRow,
            agentUserId,
            leg,
            customerPhone,
        });
    }

    return startCallNotify({
        bookingRow,
        agentUserId,
        leg,
        customerPhone,
    });
}

function buildNotifyBody(bookingRow, leg) {
    const template = TEMPLATES[defaultTemplateKey(leg)];
    const firstName = bookingRow.customer?.firstName || "there";
    return fillTemplate(template, {
        name: firstName,
        orderTrackId: bookingRow.orderTrackId || bookingRow.id,
    });
}

/**
 * Count prior notify taps (push + sms) for this booking+leg.
 * Call channel is excluded.
 */
async function countNotifyAttempts(bookingId, leg) {
    return bookingNotification.count({
        where: {
            bookingId,
            leg,
            channel: { [Op.in]: ["push", "sms"] },
        },
    });
}

/**
 * Attempts 1–3 → Firebase push; attempt 4+ → Twilio SMS.
 */
async function sendNotifyLadder({
    bookingRow,
    agentUserId,
    leg,
    customerPhone,
}) {
    const priorCount = await countNotifyAttempts(bookingRow.id, leg);
    const attemptNumber = priorCount + 1;
    const body = buildNotifyBody(bookingRow, leg);

    // Shared rate limit for notify button (push or sms)
    assertRateLimit(bookingRow.id, leg, "notify");

    if (priorCount < PUSH_ATTEMPTS_BEFORE_SMS) {
        return sendPushNotify({
            bookingRow,
            agentUserId,
            leg,
            customerPhone,
            body,
            attemptNumber,
        });
    }

    return sendSmsNotify({
        bookingRow,
        agentUserId,
        leg,
        customerPhone,
        body,
        attemptNumber,
    });
}

async function sendPushNotify({
    bookingRow,
    agentUserId,
    leg,
    customerPhone,
    body,
    attemptNumber,
}) {
    const customerId = bookingRow.customerId;
    const title = PUSH_TITLES[leg] || "Driver update";
    let pushResult = { sent: false, reason: "UNKNOWN", successCount: 0 };

    try {
        pushResult =
            (await sendNotification(
                customerId,
                title,
                body,
                {
                    bookingId: String(bookingRow.id),
                    orderTrackId: String(
                        bookingRow.orderTrackId || bookingRow.id
                    ),
                    leg,
                    type: "agent_customer_notify",
                    channel: "push",
                    attemptNumber: String(attemptNumber),
                },
                { throwOnFailure: false }
            )) || pushResult;
    } catch (err) {
        clearRateLimit(bookingRow.id, leg, "notify");
        throw new UniversalHttpError(
            err?.message || "Failed to send push notification. Please try again.",
            502
        );
    }

    const openAttempt = await loadOpenAttempt(bookingRow.id, leg);
    const sentAt = new Date();
    const bodyPreview =
        body.length > 80 ? `${body.slice(0, 77)}...` : body;
    const toMasked = maskPhone(customerPhone);

    const pushStatus = pushResult.sent
        ? "sent"
        : pushResult.reason === "NO_TOKENS"
          ? "no_tokens"
          : "failed";

    const notificationId = await logNotification({
        bookingId: bookingRow.id,
        attemptId: openAttempt?.id || null,
        leg,
        channel: "push",
        agentUserId,
        twilioSid: null,
        twilioStatus: pushStatus,
        bodyPreview,
        toMasked,
        fromNumber: "firebase",
        sentAt,
    });

    return {
        bookingId: bookingRow.id,
        orderTrackId: bookingRow.orderTrackId,
        leg,
        channel: "push",
        attemptNumber,
        attemptsBeforeSms: PUSH_ATTEMPTS_BEFORE_SMS,
        remainingPushAttempts: Math.max(
            0,
            PUSH_ATTEMPTS_BEFORE_SMS - attemptNumber
        ),
        nextChannel:
            attemptNumber >= PUSH_ATTEMPTS_BEFORE_SMS ? "sms" : "push",
        to: toMasked,
        from: "firebase",
        messageSid: null,
        callSid: null,
        twilioStatus: pushStatus,
        pushSent: Boolean(pushResult.sent),
        pushReason: pushResult.reason || null,
        bodyPreview,
        attemptId: openAttempt?.id || null,
        notificationId,
        sentAt: sentAt.toISOString(),
        message: pushResult.sent
            ? `Push notification sent (attempt ${attemptNumber} of ${PUSH_ATTEMPTS_BEFORE_SMS}).`
            : pushResult.reason === "NO_TOKENS"
              ? `No customer app device token. Attempt ${attemptNumber} of ${PUSH_ATTEMPTS_BEFORE_SMS} counted; SMS unlocks on attempt ${PUSH_ATTEMPTS_BEFORE_SMS + 1}.`
              : `Push may have failed (attempt ${attemptNumber} of ${PUSH_ATTEMPTS_BEFORE_SMS}).`,
    };
}

async function sendSmsNotify({
    bookingRow,
    agentUserId,
    leg,
    customerPhone,
    body,
    attemptNumber,
}) {
    let twilioResult;
    try {
        twilioResult = await twilioSmsService.sendSms({
            to: customerPhone,
            body,
        });
    } catch (err) {
        clearRateLimit(bookingRow.id, leg, "notify");
        throw new UniversalHttpError(
            err?.message || "Failed to send SMS via Twilio. Please try again.",
            502
        );
    }

    const openAttempt = await loadOpenAttempt(bookingRow.id, leg);
    const sentAt = new Date();
    const bodyPreview =
        body.length > 80 ? `${body.slice(0, 77)}...` : body;
    const toMasked = maskPhone(customerPhone);

    const notificationId = await logNotification({
        bookingId: bookingRow.id,
        attemptId: openAttempt?.id || null,
        leg,
        channel: "sms",
        agentUserId,
        twilioSid: twilioResult.sid,
        twilioStatus: twilioResult.status,
        bodyPreview,
        toMasked,
        fromNumber: twilioResult.from,
        sentAt,
    });

    return {
        bookingId: bookingRow.id,
        orderTrackId: bookingRow.orderTrackId,
        leg,
        channel: "sms",
        attemptNumber,
        attemptsBeforeSms: PUSH_ATTEMPTS_BEFORE_SMS,
        remainingPushAttempts: 0,
        nextChannel: "sms",
        to: toMasked,
        from: twilioResult.from,
        messageSid: twilioResult.sid,
        callSid: null,
        twilioStatus: twilioResult.status,
        bodyPreview,
        attemptId: openAttempt?.id || null,
        notificationId,
        sentAt: sentAt.toISOString(),
        message: `SMS sent (notify attempt ${attemptNumber}).`,
    };
}

async function startCallNotify({
    bookingRow,
    agentUserId,
    leg,
    customerPhone,
}) {
    if (!twilioCallService.isVoiceEnabled()) {
        throw new ValidationError(
            "Voice calling is temporarily disabled. You can still send SMS."
        );
    }

    const agentUser = await users.findOne({
        where: { id: agentUserId },
        attributes: ["id", "phoneNum", "countryCode", "firstName"],
    });

    const rawAgentPhone =
        agentUser?.phoneNum != null ? String(agentUser.phoneNum).trim() : "";
    if (!rawAgentPhone) {
        throw new ValidationError(
            "Your profile phone number is missing. Add phoneNum and countryCode on your agent profile before calling the customer."
        );
    }

    const agentPhone = normalizePhoneNumber(
        agentUser.phoneNum,
        agentUser?.countryCode
    );
    if (!agentPhone) {
        throw new ValidationError(
            "Your profile phone number is invalid. Use E.164 (e.g. +4477…) or national format with countryCode (+44 / +92)."
        );
    }

    if (agentPhone === customerPhone) {
        throw new ValidationError(
            "Agent and customer phone numbers are the same. Cannot start click-to-call."
        );
    }

    assertRateLimit(bookingRow.id, leg, "call");

    let twilioResult;
    try {
        twilioResult = await twilioCallService.startClickToCall({
            agentPhone,
            customerPhone,
        });
    } catch (err) {
        clearRateLimit(bookingRow.id, leg, "call");
        if (err?.code === "TWILIO_VOICE_DISABLED") {
            throw new ValidationError(err.message);
        }
        throw new UniversalHttpError(
            err?.message ||
                "Failed to start call via Twilio. Please try again.",
            502
        );
    }

    const openAttempt = await loadOpenAttempt(bookingRow.id, leg);
    const sentAt = new Date();
    const toMasked = maskPhone(customerPhone);
    const agentMasked = maskPhone(agentPhone);

    const notificationId = await logNotification({
        bookingId: bookingRow.id,
        attemptId: openAttempt?.id || null,
        leg,
        channel: "call",
        agentUserId,
        twilioSid: twilioResult.sid,
        twilioStatus: twilioResult.status,
        bodyPreview: "click-to-call",
        toMasked,
        fromNumber: twilioResult.from,
        sentAt,
    });

    return {
        bookingId: bookingRow.id,
        orderTrackId: bookingRow.orderTrackId,
        leg,
        channel: "call",
        to: toMasked,
        agentTo: agentMasked,
        from: twilioResult.from,
        messageSid: null,
        callSid: twilioResult.sid,
        twilioStatus: twilioResult.status,
        bodyPreview: "click-to-call",
        attemptId: openAttempt?.id || null,
        notificationId,
        sentAt: sentAt.toISOString(),
        message:
            "Calling your phone first. Answer to be connected to the customer.",
    };
}

/**
 * Contact summary for attempt-options / fail audit.
 */
async function getContactSummary({ bookingId, leg, attemptId = null }) {
    const normalizedLeg = normalizeLeg(leg) || leg;
    const rows = await bookingNotification.findAll({
        where: {
            bookingId,
            leg: normalizedLeg,
        },
        order: [["sentAt", "DESC"]],
        attributes: [
            "id",
            "channel",
            "sentAt",
            "twilioSid",
            "twilioStatus",
            "attemptId",
            "bodyPreview",
        ],
        limit: 30,
    });

    const relevant = attemptId
        ? rows.filter(
              (r) =>
                  Number(r.attemptId) === Number(attemptId) ||
                  r.attemptId == null
          )
        : rows;

    const smsRows = relevant.filter((r) => r.channel === "sms");
    const callRows = relevant.filter((r) => r.channel === "call");
    const pushRows = relevant.filter((r) => r.channel === "push");
    const latestSms = smsRows[0] || null;
    const latestCall = callRows[0] || null;
    const latestPush = pushRows[0] || null;
    const smsSent = smsRows.length > 0;
    const callMade = callRows.length > 0;
    const pushSent = pushRows.length > 0;
    const notifyAttemptCount = smsRows.length + pushRows.length;

    let latest = null;
    const candidates = [latestSms, latestCall, latestPush].filter(Boolean);
    if (candidates.length) {
        candidates.sort(
            (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
        );
        const pick = candidates[0];
        latest = {
            channel: pick.channel,
            sentAt: new Date(pick.sentAt).toISOString(),
            twilioSid: pick.twilioSid || null,
            twilioStatus: pick.twilioStatus || null,
        };
    }

    return {
        smsSent,
        smsSentAt: latestSms ? new Date(latestSms.sentAt).toISOString() : null,
        smsCount: smsRows.length,
        pushSent,
        pushSentAt: latestPush
            ? new Date(latestPush.sentAt).toISOString()
            : null,
        pushCount: pushRows.length,
        notifyAttemptCount,
        attemptsBeforeSms: PUSH_ATTEMPTS_BEFORE_SMS,
        nextNotifyChannel:
            notifyAttemptCount < PUSH_ATTEMPTS_BEFORE_SMS ? "push" : "sms",
        callMade,
        callMadeAt: latestCall
            ? new Date(latestCall.sentAt).toISOString()
            : null,
        callCount: callRows.length,
        hasContactedCustomer: smsSent || callMade || pushSent,
        latest,
    };
}

module.exports = {
    notifyCustomer,
    getContactSummary,
    normalizePhoneNumber,
    normalizeCountryDialCode,
    normalizeLeg,
    normalizeChannel,
};
