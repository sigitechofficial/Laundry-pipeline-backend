const { ConflictError } = require("../middlewares/universalErrorHandler");

/** Booking status id for Cancelled (seeded bookingStatuses). */
const CANCELLED_BOOKING_STATUS_ID = 19;

/**
 * Block agent progress APIs when the customer (or system) has already cancelled.
 * No push/socket — next API hit returns a clear error for the agent app to show.
 *
 * @param {object|null|undefined} bookingRow
 * @param {{ orderTrackId?: string } } [opts]
 */
function assertBookingNotCancelledForAgent(bookingRow, opts = {}) {
    if (!bookingRow) return;

    if (Number(bookingRow.bookingStatusId) !== CANCELLED_BOOKING_STATUS_ID) {
        return;
    }

    const orderLabel =
        opts.orderTrackId ||
        bookingRow.orderTrackId ||
        bookingRow.id ||
        "this order";

    throw new ConflictError(
        `Order #${orderLabel} has been cancelled by the customer. You cannot continue this order.`
    );
}

module.exports = {
    CANCELLED_BOOKING_STATUS_ID,
    assertBookingNotCancelledForAgent,
};
