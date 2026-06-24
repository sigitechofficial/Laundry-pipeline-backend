const {
    BOOKING_ACCEPT_WINDOW_MINUTES,
    BUSINESS_TIME_ZONE,
    isBookingAcceptWindowOpen,
} = require("./bookingTimeZone");

function getBookingVisibleAt(booking) {
    if (!booking) return null;
    return booking.agentVisibleAt || booking.createdAt;
}

/**
 * Resolve IANA timezone for admin/agent window checks.
 * @param {object} booking
 * @param {string} [timeZone]
 */
function resolveTimeZoneForBooking(booking, timeZone) {
    return (
        timeZone ||
        booking?.ianaTimeZone ||
        booking?.country?.ianaTimeZone ||
        BUSINESS_TIME_ZONE
    );
}

/**
 * Agent accept window ended (DB orderExpireTime + createdAt + timezone).
 * Same rule as getBookingHome filter — not createdAt + 30 min UTC.
 * @param {object} booking
 * @param {string} [timeZone] - from booking zone country when known
 */
function isAgentAcceptExpired(booking, timeZone) {
    if (!booking) return false;
    if (Number(booking.bookingStatusId) !== 1) return false;
    if (booking.laundryShopId != null && booking.laundryShopId !== "") {
        return false;
    }

    const createdAt = booking.createdAt;
    const orderExpireTime = booking.orderExpireTime;
    const tz = resolveTimeZoneForBooking(booking, timeZone);

    if (!createdAt || !orderExpireTime) {
        const visibleAt = getBookingVisibleAt(booking);
        if (!visibleAt) return false;
        const start = new Date(visibleAt);
        if (Number.isNaN(start.getTime())) return false;
        const expiresAt = new Date(
            start.getTime() + BOOKING_ACCEPT_WINDOW_MINUTES * 60 * 1000
        );
        return new Date() >= expiresAt;
    }

    return !isBookingAcceptWindowOpen(
        createdAt,
        orderExpireTime,
        tz
    );
}

function isUnassignedPendingBooking(booking) {
    if (!booking) return false;
    if (Number(booking.bookingStatusId) !== 1) return false;
    if (booking.laundryShopId != null && booking.laundryShopId !== '') {
        return false;
    }
    return true;
}

const TERMINAL_BOOKING_STATUS_IDS = [17, 19, 21];

function isTerminalBookingStatus(booking) {
    if (!booking) return false;
    return TERMINAL_BOOKING_STATUS_IDS.includes(Number(booking.bookingStatusId));
}

function isInvoiceFinalized(booking) {
    if (!booking) return false;
    return booking.invoiceStatus === "finalized";
}

/**
 * Admin may assign or reassign until invoice is finalized (draft allowed).
 * Completed / cancelled orders are excluded.
 */
function canAdminAssignOrReassignBooking(booking) {
    if (!booking) return false;
    if (isInvoiceFinalized(booking)) return false;
    if (isTerminalBookingStatus(booking)) return false;
    return true;
}

/** @deprecated Use canAdminAssignOrReassignBooking — kept for legacy callers */
function canAdminAssignBooking(booking, timeZone, options = {}) {
    if (canAdminAssignOrReassignBooking(booking)) {
        if (!isUnassignedPendingBooking(booking)) {
            return true;
        }
        if (options.hasAgentDecline) return true;
        return isAgentAcceptExpired(booking, timeZone);
    }
    return false;
}

module.exports = {
    BOOKING_ACCEPT_WINDOW_MINUTES,
    getBookingVisibleAt,
    resolveTimeZoneForBooking,
    isAgentAcceptExpired,
    isUnassignedPendingBooking,
    isTerminalBookingStatus,
    isInvoiceFinalized,
    canAdminAssignOrReassignBooking,
    canAdminAssignBooking,
};
