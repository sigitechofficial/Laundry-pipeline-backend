const {
    BOOKING_ACCEPT_WINDOW_MINUTES,
    BUSINESS_TIME_ZONE,
    isBookingAcceptWindowOpen,
} = require("./bookingTimeZone");

function getBookingVisibleAt(booking) {
    if (!booking) return null;
    return booking.agentVisibleAt || booking.createdAt;
}

/** Accept window anchor: after-hours bookings count from place time, others from agent visibility. */
function getAcceptWindowAnchor(booking) {
    if (!booking) return null;
    if (booking.placedOutsidePlatformHours) {
        return booking.createdAt;
    }
    return getBookingVisibleAt(booking);
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
 * Agent accept window ended (DB orderExpireTime + agentVisibleAt/createdAt + timezone).
 * Held bookings (agentBroadcastHeld) never expire until released to agents.
 * @param {object} booking
 * @param {string} [timeZone] - from booking zone country when known
 */
function isAgentAcceptExpired(booking, timeZone) {
    if (!booking) return false;
    if (booking.agentBroadcastHeld) return false;
    if (Number(booking.bookingStatusId) !== 1) return false;
    if (booking.laundryShopId != null && booking.laundryShopId !== "") {
        return false;
    }

    const windowStart = getAcceptWindowAnchor(booking);
    const orderExpireTime = booking.orderExpireTime;
    const tz = resolveTimeZoneForBooking(booking, timeZone);

    if (!orderExpireTime) {
        return false;
    }

    if (!windowStart) {
        return false;
    }

    return !isBookingAcceptWindowOpen(
        windowStart,
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

/** Status 4 = Driver Out for PickUp — assign/reassign blocked at and after this. */
const DRIVER_OUT_FOR_PICKUP_STATUS_ID = 4;

function isBeforeDriverOutForPickup(booking) {
    if (!booking) return false;
    return Number(booking.bookingStatusId) < DRIVER_OUT_FOR_PICKUP_STATUS_ID;
}

/**
 * Human-readable reason when admin assign/reassign is blocked, or null if allowed.
 */
function getAdminAssignBlockedReason(booking) {
    if (!booking) return "Booking not found";
    if (isInvoiceFinalized(booking)) {
        return "Invoice is finalized.";
    }
    if (isTerminalBookingStatus(booking)) {
        return "Order is completed or cancelled.";
    }
    if (!isBeforeDriverOutForPickup(booking)) {
        return "Cannot assign or reassign after driver is out for pickup.";
    }
    return null;
}

/**
 * Admin may assign or reassign only before driver goes out for pickup (status < 4).
 * Also blocked when invoice is finalized or order is completed/cancelled.
 */
function canAdminAssignOrReassignBooking(booking) {
    return getAdminAssignBlockedReason(booking) === null;
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
    getAcceptWindowAnchor,
    resolveTimeZoneForBooking,
    isAgentAcceptExpired,
    isUnassignedPendingBooking,
    isTerminalBookingStatus,
    isInvoiceFinalized,
    DRIVER_OUT_FOR_PICKUP_STATUS_ID,
    isBeforeDriverOutForPickup,
    getAdminAssignBlockedReason,
    canAdminAssignOrReassignBooking,
    canAdminAssignBooking,
};
