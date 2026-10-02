'use strict';

const { ORDER_CREATED } = require('../constants/bookingStatusIds');

/** Drop queued rows older than this even if the client never acked. */
const MAX_QUEUE_AGE_MS = 48 * 60 * 60 * 1000;

/** newBookingRequest older than this is not a live marketplace offer. */
const NEW_BOOKING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function toFiniteId(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function extractQueuedBookingId(payload) {
    if (payload == null) return null;
    if (typeof payload === 'number' || typeof payload === 'string') {
        return toFiniteId(payload);
    }
    if (typeof payload !== 'object') return null;

    const nested = payload.data;
    const nestedId =
        nested != null && typeof nested === 'object'
            ? nested.bookingId ?? nested.id
            : nested;

    return toFiniteId(
        payload.bookingId ?? payload.id ?? nestedId
    );
}

function isAssignedShopId(laundryShopId) {
    if (laundryShopId == null || laundryShopId === '') return false;
    const n = Number(laundryShopId);
    if (Number.isFinite(n)) return n !== 0;
    const text = String(laundryShopId).trim().toLowerCase();
    return text !== 'null' && text !== 'undefined';
}

/**
 * Stale newBookingRequest must not be replayed: the order is already assigned,
 * no longer "Order Created", missing, or older than a day.
 */
function shouldDropQueuedNewBooking(bookingRow) {
    if (!bookingRow) return true;
    if (isAssignedShopId(bookingRow.laundryShopId)) return true;
    if (Number(bookingRow.bookingStatusId) !== ORDER_CREATED) return true;
    if (bookingRow.createdAt) {
        const age = Date.now() - new Date(bookingRow.createdAt).getTime();
        if (Number.isFinite(age) && age > NEW_BOOKING_MAX_AGE_MS) return true;
    }
    return false;
}

function isQueuedEventExpired(createdAt, nowMs = Date.now()) {
    if (!createdAt) return false;
    const age = nowMs - new Date(createdAt).getTime();
    return Number.isFinite(age) && age > MAX_QUEUE_AGE_MS;
}

module.exports = {
    MAX_QUEUE_AGE_MS,
    NEW_BOOKING_MAX_AGE_MS,
    extractQueuedBookingId,
    isAssignedShopId,
    shouldDropQueuedNewBooking,
    isQueuedEventExpired,
};
