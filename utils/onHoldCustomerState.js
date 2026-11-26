/**
 * Where an order stands for the customer's On-Hold screen.
 *
 * It is "waiting" while the order is in the on-hold status (18) and at least
 * one held item still has no answer from the customer and was not taken off
 * by the shop. Every other order that ever had a held item is "resolved".
 */
const ON_HOLD_STATUS_ID = 18;

function isAnswered(c) {
    return Boolean(c && (c.responseConformation === true || c.responseConformation === 1));
}

function isRemoved(c) {
    return Boolean(c && (c.deleted === true || c.deleted === 1));
}

function onHoldCustomerState(bookingStatusId, confirmations = []) {
    const items = Array.isArray(confirmations) ? confirmations : [];
    const open = items.filter((c) => !isAnswered(c) && !isRemoved(c));
    const waiting = Number(bookingStatusId) === ON_HOLD_STATUS_ID && open.length > 0;
    return {
        total: items.length,
        waitingItems: waiting ? open.length : 0,
        resolved: items.length > 0 && !waiting,
        waiting,
    };
}

module.exports = { onHoldCustomerState, ON_HOLD_STATUS_ID };
