'use strict';

/**
 * Pure helpers of the shop app's Reports (services/Agent/shopReportsService.js):
 * no database access, so they are unit-tested on their own.
 */
const {
    COMPLETED,
    ISSUE_RESOLVED,
    CANCELLED,
    REFUNDED,
    ON_HOLD,
} = require('../constants/bookingStatusIds');
const { classifyArrivalInZone } = require('./bookingPunctuality');
const { emptyPunctuality, addArrival, finalizePunctuality } = require('./performanceDashboard');

/** Finished successfully (an issue resolved after completion is still finished). */
const DONE = [COMPLETED, ISSUE_RESOLVED];
const NOT_LIVE = [...DONE, CANCELLED, REFUNDED];

function pct(count, total) {
    return total ? Math.round((count / total) * 1000) / 10 : 0;
}

/**
 * Order-status buckets for orders placed in a range. Each order is in exactly
 * one bucket, so the buckets add up to the total.
 * @param {Array<{ bookingStatusId: number }>} orders
 */
function statusBuckets(orders) {
    const totals = { completed: 0, inProgress: 0, onHold: 0, cancelled: 0, refunded: 0 };
    for (const o of orders) {
        const id = Number(o.bookingStatusId);
        if (DONE.includes(id)) totals.completed += 1;
        else if (id === CANCELLED) totals.cancelled += 1;
        else if (id === REFUNDED) totals.refunded += 1;
        else if (ON_HOLD.includes(id)) totals.onHold += 1;
        else totals.inProgress += 1;
    }
    return totals;
}

/** Shop-level punctuality per leg kind from completed legs (see performanceDashboardService). */
function legPunctuality(legs) {
    const acc = { pickup: emptyPunctuality(), delivery: emptyPunctuality() };
    for (const leg of legs) {
        const target = acc[leg.kind];
        if (!target) continue;
        addArrival(
            target,
            classifyArrivalInZone(leg.arrivedAt, leg.slotDay, leg.slotFrom, leg.slotTo, leg.slotTimeZone)
        );
    }
    return { pickup: finalizePunctuality(acc.pickup), delivery: finalizePunctuality(acc.delivery) };
}

module.exports = { DONE, NOT_LIVE, pct, statusBuckets, legPunctuality };
