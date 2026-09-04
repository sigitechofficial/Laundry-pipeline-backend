/**
 * Admin: Twilio / notify / dialer call logs from DB.
 */

const { Op } = require("sequelize");
const {
    bookingNotification,
    bookingCallSession,
    booking,
    users,
} = require("../../models");

function parsePaging(query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}

function buildDateWhere(field, startDate, endDate) {
    if (!startDate && !endDate) return null;
    const range = {};
    if (startDate) range[Op.gte] = new Date(`${startDate}T00:00:00.000Z`);
    if (endDate) range[Op.lte] = new Date(`${endDate}T23:59:59.999Z`);
    return { [field]: range };
}

function formatUser(user) {
    if (!user) return null;
    const plain = typeof user.toJSON === "function" ? user.toJSON() : user;
    return {
        id: plain.id,
        firstName: plain.firstName || null,
        lastName: plain.lastName || null,
        email: plain.email || null,
        phoneNum: plain.phoneNum || null,
        countryCode: plain.countryCode || null,
    };
}

function formatNotificationRow(row) {
    const plain = typeof row.toJSON === "function" ? row.toJSON() : row;
    const bookingRow = plain.booking || null;
    const customer = bookingRow?.customer || null;
    const agent = plain.agent || null;

    return {
        id: plain.id,
        bookingId: plain.bookingId,
        orderTrackId: bookingRow?.orderTrackId || null,
        attemptId: plain.attemptId,
        leg: plain.leg,
        channel: plain.channel,
        agentUserId: plain.agentUserId,
        agent: formatUser(agent),
        customerId: bookingRow?.customerId || customer?.id || null,
        customer: formatUser(customer),
        customerPhone: customer?.phoneNum || null,
        customerCountryCode: customer?.countryCode || null,
        toMasked: plain.toMasked,
        fromNumber: plain.fromNumber,
        twilioSid: plain.twilioSid,
        twilioStatus: plain.twilioStatus,
        bodyPreview: plain.bodyPreview,
        sentAt: plain.sentAt,
        deliveredAt: plain.deliveredAt || null,
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
    };
}

/**
 * Human-readable call outcome from the Twilio call status / close reason.
 */
function deriveCallOutcome(callStatus, closeReason) {
    const status = String(callStatus || "").toLowerCase().trim();
    const reason = String(closeReason || "").toLowerCase().trim();
    const key = status || reason.replace(/^call_/, "").replace(/_/g, "-");

    switch (key) {
        case "completed":
            return "Completed";
        case "answered":
        case "in-progress":
            return "Answered";
        case "no-answer":
            return "No answer";
        case "busy":
            return "Busy";
        case "failed":
            return "Failed";
        case "canceled":
        case "cancelled":
            return "Canceled";
        default:
            if (reason === "replaced") return "Replaced";
            if (reason === "ttl_expired") return "Expired (no call)";
            if (reason === "booking_missing") return "Booking missing";
            return null;
    }
}

function formatSessionRow(row) {
    const plain = typeof row.toJSON === "function" ? row.toJSON() : row;
    const bookingRow = plain.booking || null;
    const customer = bookingRow?.customer || null;
    const agent = plain.agent || null;

    return {
        id: plain.id,
        bookingId: plain.bookingId,
        orderTrackId: bookingRow?.orderTrackId || null,
        leg: plain.leg,
        agentUserId: plain.agentUserId,
        agent: formatUser(agent),
        agentPhoneE164: plain.agentPhoneE164,
        customerId: bookingRow?.customerId || customer?.id || null,
        customer: formatUser(customer),
        customerPhone: customer?.phoneNum || null,
        customerCountryCode: customer?.countryCode || null,
        status: plain.status,
        expiresAt: plain.expiresAt,
        closedAt: plain.closedAt,
        closeReason: plain.closeReason,
        callSid: plain.callSid || null,
        callStatus: plain.callStatus || null,
        callDurationSec:
            plain.callDurationSec != null ? Number(plain.callDurationSec) : null,
        connectedAt: plain.connectedAt || null,
        endedAt: plain.endedAt || null,
        outcome: deriveCallOutcome(plain.callStatus, plain.closeReason),
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt,
    };
}

async function listNotifyLogs(query = {}) {
    const { page, limit, offset } = parsePaging(query);
    const {
        channel,
        bookingId,
        agentUserId,
        leg,
        startDate,
        endDate,
        type = "all",
    } = query;

    const includeBookingCustomer = {
        model: booking,
        as: "booking",
        required: false,
        attributes: ["id", "orderTrackId", "customerId", "bookingStatusId"],
        include: [
            {
                model: users,
                as: "customer",
                required: false,
                attributes: [
                    "id",
                    "firstName",
                    "lastName",
                    "email",
                    "phoneNum",
                    "countryCode",
                ],
            },
        ],
    };

    const agentInclude = {
        model: users,
        as: "agent",
        required: false,
        attributes: [
            "id",
            "firstName",
            "lastName",
            "email",
            "phoneNum",
            "countryCode",
        ],
    };

    const result = {
        filters: {
            type,
            channel: channel || null,
            bookingId: bookingId || null,
            agentUserId: agentUserId || null,
            leg: leg || null,
            startDate: startDate || null,
            endDate: endDate || null,
            page,
            limit,
        },
    };

    const wantNotifications = type === "all" || type === "notifications";
    const wantSessions = type === "all" || type === "sessions";

    if (wantNotifications) {
        const where = {};
        if (channel) {
            // Explicit channel filter (sms / push / call) is respected as-is.
            where.channel = String(channel).toLowerCase().trim();
        }
        // No channel filter → return every notification row (sms + push + call).
        // The admin UI has a dedicated Channel column so call markers are
        // distinguishable from SMS/push; filtering is optional via ?channel=.
        if (bookingId) where.bookingId = Number(bookingId);
        if (agentUserId) where.agentUserId = Number(agentUserId);
        if (leg) where.leg = String(leg).toLowerCase().trim();
        const dateWhere = buildDateWhere("sentAt", startDate, endDate);
        if (dateWhere) Object.assign(where, dateWhere);

        const { rows, count } = await bookingNotification.findAndCountAll({
            where,
            include: [includeBookingCustomer, agentInclude],
            order: [["sentAt", "DESC"], ["id", "DESC"]],
            limit,
            offset,
            distinct: true,
        });

        result.notifications = {
            total: count,
            page,
            limit,
            rows: rows.map(formatNotificationRow),
        };
    }

    if (wantSessions) {
        // Safety net for missed Twilio status callbacks: any session still
        // marked "active" past its TTL is reconciled to "expired" before we
        // read, so the admin panel never shows a stale Active session forever.
        try {
            await bookingCallSession.update(
                {
                    status: "expired",
                    closedAt: new Date(),
                    closeReason: "ttl_expired",
                },
                {
                    where: {
                        status: "active",
                        expiresAt: { [Op.lt]: new Date() },
                    },
                }
            );
        } catch (err) {
            console.error(
                "[notifyLogs] expire stale sessions failed:",
                err.message
            );
        }

        const where = {};
        if (bookingId) where.bookingId = Number(bookingId);
        if (agentUserId) where.agentUserId = Number(agentUserId);
        if (leg) where.leg = String(leg).toLowerCase().trim();
        if (query.sessionStatus) {
            where.status = String(query.sessionStatus).toLowerCase().trim();
        }
        const dateWhere = buildDateWhere("createdAt", startDate, endDate);
        if (dateWhere) Object.assign(where, dateWhere);

        const { rows, count } = await bookingCallSession.findAndCountAll({
            where,
            include: [includeBookingCustomer, agentInclude],
            order: [["createdAt", "DESC"], ["id", "DESC"]],
            limit,
            offset,
            distinct: true,
        });

        result.callSessions = {
            total: count,
            page,
            limit,
            rows: rows.map(formatSessionRow),
        };
    }

    return result;
}

module.exports = {
    listNotifyLogs,
};
