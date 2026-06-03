const { BOOKING_ACCEPT_WINDOW_MINUTES } = require("./bookingTimeZone");

function getBookingVisibleAt(booking) {
    if (!booking) return null;
    return booking.agentVisibleAt || booking.createdAt;
}

/**
 * Agent accept window ended; still unassigned (status 1, no shop).
 */
function isAgentAcceptExpired(booking, now = new Date()) {
    if (!booking) return false;
    if (Number(booking.bookingStatusId) !== 1) return false;
    if (booking.laundryShopId != null && booking.laundryShopId !== "") {
        return false;
    }
    const visibleAt = getBookingVisibleAt(booking);
    if (!visibleAt) return false;
    const start = new Date(visibleAt);
    if (Number.isNaN(start.getTime())) return false;
    const expiresAt = new Date(
        start.getTime() + BOOKING_ACCEPT_WINDOW_MINUTES * 60 * 1000
    );
    return now >= expiresAt;
}

function canAdminAssignBooking(booking, now = new Date()) {
    return isAgentAcceptExpired(booking, now);
}

module.exports = {
    BOOKING_ACCEPT_WINDOW_MINUTES,
    getBookingVisibleAt,
    isAgentAcceptExpired,
    canAdminAssignBooking,
};
