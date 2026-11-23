'use strict';

const { TIMING, classifyArrivalInZone } = require('./bookingPunctuality');

/**
 * Pure aggregation for the shop app's Performance Dashboard
 * (services/Agent/performanceDashboardService.js loads the rows).
 *
 * Who did a leg ("driver side"):
 *   owner       - the shop owner account itself
 *   staff       - a user whose employeeOff is the shop owner (any role)
 *   third_party - anyone else (e.g. a 'Freelance Driver' account, or a driver
 *                 set by an admin who is not on this shop's team)
 * A leg with no recorded person is "unattributed" and kept out of both sides.
 */
const DRIVER_SIDE = Object.freeze({
    OWNER: 'owner',
    STAFF: 'staff',
    THIRD_PARTY: 'third_party',
});

function toId(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function driverSide(userId, ownerId, employeeIds) {
    const id = toId(userId);
    if (id == null) return null;
    if (id === toId(ownerId)) return DRIVER_SIDE.OWNER;
    if (employeeIds.has(id)) return DRIVER_SIDE.STAFF;
    return DRIVER_SIDE.THIRD_PARTY;
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Signed % change, 1 decimal. Null when there is no previous amount to compare with. */
function percentChange(current, previous) {
    const prev = Number(previous);
    if (!Number.isFinite(prev) || prev <= 0) return null;
    return round1(((Number(current) - prev) / prev) * 100);
}

function emptyPunctuality() {
    return { measured: 0, early: 0, onTime: 0, late: 0, unmeasured: 0, lateMinutesTotal: 0 };
}

function addArrival(acc, result) {
    if (!result) {
        acc.unmeasured += 1;
        return;
    }
    acc.measured += 1;
    if (result.timing === TIMING.EARLY) acc.early += 1;
    else if (result.timing === TIMING.LATE) {
        acc.late += 1;
        acc.lateMinutesTotal += result.minutesLate;
    } else acc.onTime += 1;
}

/**
 * onTimePercent = arrivals inside the slot / measured arrivals (null when none
 * could be measured). averageMinutesLate = mean minutes past the slot end over
 * the late arrivals only (null when none was late).
 */
function finalizePunctuality(acc) {
    return {
        measured: acc.measured,
        early: acc.early,
        onTime: acc.onTime,
        late: acc.late,
        unmeasured: acc.unmeasured,
        onTimePercent: acc.measured > 0 ? round1((acc.onTime / acc.measured) * 100) : null,
        averageMinutesLate: acc.late > 0 ? round1(acc.lateMinutesTotal / acc.late) : null,
    };
}

/**
 * @param {object} input
 * @param {Array<{ kind: 'pickup'|'delivery', userId: number|null, arrivedAt: Date|string|null,
 *   slotDay: string|null, slotFrom: string|null, slotTo: string|null, slotTimeZone: string|null }>} input.legs
 *   one row per pickup / delivery completed in the range
 * @param {number} input.ownerId shop owner user id
 * @param {Iterable<number>} input.employeeIds users whose employeeOff is the owner
 * @param {Map<number, { firstName?: string, lastName?: string }>} input.people names by id
 * @param {Iterable<number>} [input.rosterDriverIds] shop drivers listed even with no legs
 */
function summarizeLegs({ legs, ownerId, employeeIds, people, rosterDriverIds = [] }) {
    const staff = new Set([...employeeIds].map(toId).filter((id) => id != null));
    const rows = new Map();
    const rowFor = (id) => {
        if (!rows.has(id)) {
            const person = people.get(id) || {};
            rows.set(id, {
                id,
                firstName: person.firstName ?? null,
                lastName: person.lastName ?? null,
                driverType: driverSide(id, ownerId, staff),
                pickups: 0,
                deliveries: 0,
                collection: emptyPunctuality(),
                delivery: emptyPunctuality(),
            });
        }
        return rows.get(id);
    };
    for (const id of rosterDriverIds) {
        const rid = toId(id);
        if (rid != null) rowFor(rid);
    }

    let pickups = 0;
    let deliveries = 0;
    const split = { agentDriversDeliveries: 0, freelanceDriverDeliveries: 0, unattributedDeliveries: 0 };

    for (const leg of legs) {
        const isDelivery = leg.kind === 'delivery';
        if (isDelivery) deliveries += 1;
        else pickups += 1;

        const id = toId(leg.userId);
        const side = driverSide(id, ownerId, staff);
        if (isDelivery) {
            if (side == null) split.unattributedDeliveries += 1;
            else if (side === DRIVER_SIDE.THIRD_PARTY) split.freelanceDriverDeliveries += 1;
            else split.agentDriversDeliveries += 1;
        }
        if (id == null) continue;

        const row = rowFor(id);
        const timing = classifyArrivalInZone(
            leg.arrivedAt,
            leg.slotDay,
            leg.slotFrom,
            leg.slotTo,
            leg.slotTimeZone
        );
        if (isDelivery) {
            row.deliveries += 1;
            addArrival(row.delivery, timing);
        } else {
            row.pickups += 1;
            addArrival(row.collection, timing);
        }
    }

    const driverPerformance = [...rows.values()]
        .map(({ collection, delivery, ...row }) => ({
            ...row,
            collectionPunctuality: finalizePunctuality(collection),
            deliveryPunctuality: finalizePunctuality(delivery),
        }))
        .sort(
            (a, b) =>
                b.pickups + b.deliveries - (a.pickups + a.deliveries) ||
                `${a.firstName || ''} ${a.lastName || ''}`.localeCompare(`${b.firstName || ''} ${b.lastName || ''}`) ||
                a.id - b.id
        );

    return { pickups, deliveries, deliveryTypeSplit: split, driverPerformance };
}

/**
 * Commission split of the shop's paid orders in the range.
 * @param {{ orders: number, shopEarning: number, platformCommission: number, platformServiceFees: number }} totals
 * @param {Array<{ shopPercent: number|null, platformPercent: number|null, orders: number }>} rates
 *   orders grouped by the commission % frozen on the booking at accept
 */
function buildCommissionSummary(totals, rates) {
    return {
        paidOrders: Number(totals.orders) || 0,
        shopEarning: money(totals.shopEarning),
        platformCommission: money(totals.platformCommission),
        platformServiceFees: money(totals.platformServiceFees),
        commissionRates: rates
            .map((r) => ({
                shopPercent: r.shopPercent == null ? null : Number(r.shopPercent),
                platformPercent: r.platformPercent == null ? null : Number(r.platformPercent),
                orders: Number(r.orders) || 0,
            }))
            .sort((a, b) => b.orders - a.orders),
    };
}

module.exports = {
    DRIVER_SIDE,
    driverSide,
    percentChange,
    money,
    emptyPunctuality,
    addArrival,
    finalizePunctuality,
    summarizeLegs,
    buildCommissionSummary,
};
