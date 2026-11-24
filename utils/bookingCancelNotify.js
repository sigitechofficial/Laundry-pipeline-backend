'use strict';

/**
 * Tell the shop side that the customer cancelled a booking.
 *
 * The customer cancel flow used to change the booking to Cancelled (19) without telling
 * anyone, so an assigned shop or driver kept the job on screen and could still go out to
 * collect. Recipients:
 *   - the owner of the shop that has the booking (laundryShopId), or of the shop an admin
 *     targeted while it waits for that shop to accept (adminAssignedShopId);
 *   - the assigned driver, when that is a different user from the owner.
 * Each gets a socket event (removes the order from the open app at once) and a push.
 * A booking still waiting in the open New list has no recipients here: the list only
 * shows status 1, so it drops out on the next refresh.
 */

const CANCELLED_BY_CUSTOMER_EVENT = 'bookingCancelledByCustomer';

function toUserId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** The shop address id whose owner is told: the accepted shop first, else the admin target. */
function cancelNotifyShopAddressId(bookingRow) {
    return toUserId(bookingRow?.laundryShopId) || toUserId(bookingRow?.adminAssignedShopId);
}

/** Distinct user ids to tell, shop owner first. */
function cancelNotifyRecipients({ shopOwnerUserId, driverId }) {
    const ids = [toUserId(shopOwnerUserId), toUserId(driverId)].filter(Boolean);
    return [...new Set(ids)];
}

function cancelNotifyMessage(bookingRow) {
    const label = bookingRow?.orderTrackId || String(bookingRow?.id);
    return {
        title: 'Order cancelled',
        body: `Order #${label} was cancelled by the customer. Do not collect it.`,
    };
}

/**
 * @param {object} bookingRow needs id, orderTrackId, laundryShopId, adminAssignedShopId, driverId
 * @param {object} deps
 * @param {(addressId: number) => Promise<number|null>} deps.findShopOwnerUserId
 * @param {(userId: number, event: object) => Promise<any>} deps.sendEvent
 * @param {(userId: number, title: string, body: string, data: object) => Promise<any>} deps.sendNotification
 * @returns {Promise<number[]>} the user ids that were told. Never throws.
 */
async function notifyShopOfCustomerCancellation(bookingRow, deps) {
    try {
        const shopAddressId = cancelNotifyShopAddressId(bookingRow);
        const shopOwnerUserId = shopAddressId ? await deps.findShopOwnerUserId(shopAddressId) : null;
        const recipients = cancelNotifyRecipients({
            shopOwnerUserId,
            driverId: bookingRow?.driverId,
        });
        if (!recipients.length) return [];

        const bookingId = Number(bookingRow.id);
        const { title, body } = cancelNotifyMessage(bookingRow);
        await Promise.all(
            recipients.map(async (userId) => {
                try {
                    await deps.sendEvent(userId, {
                        type: CANCELLED_BY_CUSTOMER_EVENT,
                        data: { bookingId, message: body },
                    });
                } catch (err) {
                    console.error(`[cancel] socket to user ${userId} failed:`, err?.message || err);
                }
                try {
                    await deps.sendNotification(userId, title, body, {
                        bookingId: String(bookingId),
                        orderTrackId: String(bookingRow.orderTrackId || ''),
                        type: CANCELLED_BY_CUSTOMER_EVENT,
                        message: body,
                    });
                } catch (err) {
                    console.error(`[cancel] push to user ${userId} failed:`, err?.message || err);
                }
            })
        );
        return recipients;
    } catch (err) {
        console.error('[cancel] shop notification failed:', err?.message || err);
        return [];
    }
}

module.exports = {
    CANCELLED_BY_CUSTOMER_EVENT,
    cancelNotifyShopAddressId,
    cancelNotifyRecipients,
    cancelNotifyMessage,
    notifyShopOfCustomerCancellation,
};
