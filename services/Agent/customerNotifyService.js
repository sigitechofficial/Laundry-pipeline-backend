/**
 * Agent → customer SMS (Twilio) when reached for pickup / delivery.
 */

const { booking, users, addressDb, bookingAttempt, bookingNotification } = require("../../models");
const {
    ValidationError,
    NotFoundError,
    ForbiddenError,
    TooManyRequestsError,
    UniversalHttpError,
} = require("../../middlewares/universalErrorHandler");
const { assertBookingNotCancelledForAgent } = require("../../utils/assertBookingNotCancelledForAgent");
const twilioSmsService = require("../twilioSmsService");
const { maskPhoneNumber } = require("../../utils/maskPhone");

const RATE_LIMIT_MS = 2 * 60 * 1000;
/** @type {Map<string, number>} */
const recentSmsByKey = new Map();

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
    if (dialDigits && phone.startsWith(dialDigits) && phone.length > dialDigits.length + 6) {
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

function assertRateLimit(bookingId, leg) {
    const key = `${bookingId}:${leg}:sms`;
    const now = Date.now();
    const last = recentSmsByKey.get(key) || 0;
    if (now - last < RATE_LIMIT_MS) {
        const waitSec = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        throw new TooManyRequestsError(
            `Please wait ${waitSec}s before sending another SMS for this ${leg}.`
        );
    }
    // prune old entries occasionally
    if (recentSmsByKey.size > 500) {
        for (const [k, ts] of recentSmsByKey) {
            if (now - ts > RATE_LIMIT_MS) recentSmsByKey.delete(k);
        }
    }
    recentSmsByKey.set(key, now);
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

/**
 * @param {object} params
 * @param {number|string} params.bookingId
 * @param {number} params.agentUserId
 * @param {string} params.leg - pickup | delivery
 * @param {string} [params.channel] - sms (call later)
 * @param {string} params.customMessage - required free-text SMS body (max 320)
 */
async function notifyCustomer({
    bookingId,
    agentUserId,
    leg: rawLeg,
    channel = "sms",
    customMessage,
}) {
    const leg = normalizeLeg(rawLeg);
    if (!leg) {
        throw new ValidationError('leg must be "pickup" or "delivery"');
    }

    const normalizedChannel = String(channel || "sms").toLowerCase().trim();
    if (normalizedChannel !== "sms") {
        throw new ValidationError(
            'Only channel "sms" is supported for now. Call coming soon.'
        );
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
            "SMS for pickup is only allowed after driver reached pickup (status 5)."
        );
    }
    if (leg === "delivery" && !DELIVERY_STATUS_IDS.has(statusId)) {
        throw new ValidationError(
            "SMS for delivery is only allowed when out for delivery or driver reached (status 13–14)."
        );
    }

    const phone = normalizePhoneNumber(
        bookingRow.customer?.phoneNum,
        bookingRow.customer?.countryCode
    );
    if (!phone) {
        throw new ValidationError(
            "Customer phone number is missing or invalid. Cannot send SMS."
        );
    }

    const trimmedCustom =
        customMessage != null ? String(customMessage).trim() : "";
    if (!trimmedCustom) {
        throw new ValidationError(
            "customMessage is required. Agent must type the SMS text."
        );
    }
    if (trimmedCustom.length > 320) {
        throw new ValidationError("customMessage must be 320 characters or less");
    }
    const body = trimmedCustom;

    assertRateLimit(bookingRow.id, leg);

    let twilioResult;
    try {
        twilioResult = await twilioSmsService.sendSms({ to: phone, body });
    } catch (err) {
        // undo rate limit so agent can retry after real Twilio failures
        recentSmsByKey.delete(`${bookingRow.id}:${leg}:sms`);
        const msg =
            err?.message ||
            "Failed to send SMS via Twilio. Please try again.";
        throw new UniversalHttpError(msg, 502);
    }

    const openAttempt = await bookingAttempt.findOne({
        where: {
            bookingId: bookingRow.id,
            attemptType: leg,
            status: "arrived",
        },
        order: [["id", "DESC"]],
        attributes: ["id"],
    });

    const sentAt = new Date();
    const bodyPreview =
        body.length > 80 ? `${body.slice(0, 77)}...` : body;
    const toMasked = maskPhone(phone);

    let notificationId = null;
    try {
        const row = await bookingNotification.create({
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
        notificationId = row.id;
    } catch (logErr) {
        console.error(
            `[customerNotify] failed to log SMS for booking ${bookingRow.id}:`,
            logErr.message
        );
    }

    return {
        bookingId: bookingRow.id,
        orderTrackId: bookingRow.orderTrackId,
        leg,
        channel: "sms",
        to: toMasked,
        from: twilioResult.from,
        messageSid: twilioResult.sid,
        twilioStatus: twilioResult.status,
        bodyPreview,
        attemptId: openAttempt?.id || null,
        notificationId,
        sentAt: sentAt.toISOString(),
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
    const latestSms = smsRows[0] || null;
    const latestCall = callRows[0] || null;
    const smsSent = smsRows.length > 0;
    const callMade = callRows.length > 0;

    let latest = null;
    if (latestSms || latestCall) {
        const smsTs = latestSms ? new Date(latestSms.sentAt).getTime() : 0;
        const callTs = latestCall ? new Date(latestCall.sentAt).getTime() : 0;
        const pick = smsTs >= callTs ? latestSms : latestCall;
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
        callMade,
        callMadeAt: latestCall
            ? new Date(latestCall.sentAt).toISOString()
            : null,
        callCount: callRows.length,
        hasContactedCustomer: smsSent || callMade,
        latest,
    };
}

module.exports = {
    notifyCustomer,
    getContactSummary,
    normalizePhoneNumber,
    normalizeCountryDialCode,
    normalizeLeg,
};
