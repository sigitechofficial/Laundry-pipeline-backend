const { sendEvent } = require("../socket_io");
const { sendNotification } = require("./notification");

/**
 * Push + socket for previous shop owner and customer on admin assign/reassign.
 * New shop owner is notified via notifyBookingTakenByAgent (AcceptedOrder).
 */
async function notifyAdminBookingAssignment({
    bookingId,
    orderTrackId,
    customerId,
    previousOwnerUserId,
    isReassign,
}) {
    const numericBookingId = Number(bookingId);
    const orderLabel = orderTrackId || String(bookingId);

    if (previousOwnerUserId) {
        const removedTitle = isReassign
            ? "Order reassigned"
            : "Order update";
        const removedBody = isReassign
            ? `Order #${orderLabel} was reassigned to another shop by admin.`
            : `Order #${orderLabel} is no longer assigned to your shop.`;

        await sendEvent(previousOwnerUserId, {
            type: "orderReassignedFromYou",
            data: {
                bookingId: numericBookingId,
                message: removedBody,
            },
        });

        await sendNotification(
            previousOwnerUserId,
            removedTitle,
            removedBody,
            { bookingId: numericBookingId, type: "orderReassignedFromYou" }
        );
    }

    if (customerId) {
        const customerTitle = isReassign ? "Shop updated" : "Shop assigned";
        const customerBody = isReassign
            ? `Your order #${orderLabel} has been assigned to a new laundry shop.`
            : `Your order #${orderLabel} has been assigned to a laundry shop.`;

        await sendNotification(
            customerId,
            customerTitle,
            customerBody,
            { bookingId: numericBookingId, type: "adminShopAssignment" }
        );
    }
}

module.exports = {
    notifyAdminBookingAssignment,
};
