/**
 * Idempotent / race-safe handling when an agent status transition was already
 * applied by another actor (owner vs driver/employee).
 *
 * Returns HTTP 200 + status "1" with code STATUS_ALREADY_UPDATED so clients can
 * sync UI to the current booking status instead of staying stuck on a failure.
 */

const ResponseHelper = require('./responseHelper');

const FALLBACK_STATUS_TITLES = Object.freeze({
    3: 'Awaiting Collection',
    4: 'Out for Pickup',
    5: 'Driver Reached Pickup',
    6: 'Collecting Items',
    7: 'In Transit to Facility',
    8: 'Arrived at Facility',
    9: 'Items Checked In',
    10: 'Invoice Generated',
    11: 'Processing',
    12: 'Ready for Delivery',
    13: 'Out for Delivery',
    14: 'Driver Reached',
    15: 'Delivery Failed',
    16: 'Delivered',
    17: 'Completed',
    18: 'On Hold',
    19: 'Cancelled',
});

const STATUS_ALREADY_UPDATED = 'STATUS_ALREADY_UPDATED';

function isOwnerOrManagerActor(req) {
    return req?.isShopOwner === true || req?.isShopManager === true;
}

function inferMarkedBy(req) {
    // Second actor is owner/manager → first actor was almost certainly staff.
    return isOwnerOrManagerActor(req) ? 'driver_employee' : 'agent';
}

function buildAlreadyMarkedMessage(req) {
    return isOwnerOrManagerActor(req)
        ? 'Status already marked by driver/employee'
        : 'Status already marked by agent';
}

async function resolveStatusTitle(statusId) {
    const id = Number(statusId);
    try {
        const { bookingStatus } = require('../models');
        const row = await bookingStatus.findByPk(id, {
            attributes: ['id', 'title'],
        });
        if (row?.title) return row.title;
    } catch (_) {
        // Fall through to static copy
    }
    return FALLBACK_STATUS_TITLES[id] || `Status ${id}`;
}

/**
 * Build the standard already-updated payload (without sending a response).
 */
async function buildAlreadyUpdatedPayload({
    req,
    bookingId,
    currentStatusId,
    targetStatusId,
    extraData = {},
}) {
    const current = Number(currentStatusId);
    const title = await resolveStatusTitle(current);
    return {
        code: STATUS_ALREADY_UPDATED,
        alreadyUpdated: true,
        bookingId: Number(bookingId),
        bookingStatusId: current,
        bookingStatus: { id: current, title },
        requestedStatusId: Number(targetStatusId),
        markedBy: inferMarkedBy(req),
        ...extraData,
    };
}

/**
 * If booking is already at or past the target status for this transition,
 * write a success response and return true. Caller should return immediately.
 *
 * @returns {Promise<boolean>}
 */
async function respondIfAlreadyAdvanced(
    res,
    { req, bookingId, currentStatusId, targetStatusId, extraData = {}, message }
) {
    const current = Number(currentStatusId);
    const target = Number(targetStatusId);
    if (!Number.isFinite(current) || !Number.isFinite(target) || current < target) {
        return false;
    }

    const payload = await buildAlreadyUpdatedPayload({
        req,
        bookingId,
        currentStatusId: current,
        targetStatusId: target,
        extraData,
    });

    ResponseHelper.success(
        res,
        message || buildAlreadyMarkedMessage(req),
        payload
    );
    return true;
}

module.exports = {
    STATUS_ALREADY_UPDATED,
    FALLBACK_STATUS_TITLES,
    isOwnerOrManagerActor,
    inferMarkedBy,
    buildAlreadyMarkedMessage,
    resolveStatusTitle,
    buildAlreadyUpdatedPayload,
    respondIfAlreadyAdvanced,
};
