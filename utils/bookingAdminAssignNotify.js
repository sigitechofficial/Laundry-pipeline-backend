const { sendEvent } = require("../socket_io");
const { sendNotification } = require("./notification");

/**
 * Push + socket when admin assigns or reassigns a booking (pending target accept).
 */
async function notifyAdminBookingAssignment({
    bookingId,
    orderTrackId,
    customerId,
    previousOwnerUserId,
    newOwnerUserId,
    isReassign,
}) {
    const numericBookingId = Number(bookingId);
    const orderLabel = orderTrackId || String(bookingId);

    if (previousOwnerUserId && Number(previousOwnerUserId) !== Number(newOwnerUserId)) {
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

    if (newOwnerUserId) {
        const assignedTitle = "New order to accept";
        const assignedBody = isReassign
            ? `Admin assigned order #${orderLabel} to your shop. Please accept to continue.`
            : `Admin assigned order #${orderLabel} to your shop. Please accept to continue.`;

        await sendEvent(newOwnerUserId, {
            type: "adminOrderPendingAccept",
            data: {
                bookingId: numericBookingId,
                message: assignedBody,
            },
        });

        await sendNotification(
            newOwnerUserId,
            assignedTitle,
            assignedBody,
            { bookingId: numericBookingId, type: "adminOrderPendingAccept" }
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
