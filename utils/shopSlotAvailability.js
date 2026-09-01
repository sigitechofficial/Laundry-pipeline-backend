'use strict';

/**
 * Does a shop already have live work in the pickup / delivery window a new
 * booking is asking for?
 *
 * Used by preferred-shop routing (phase 1) and the zone broadcast (phase 2) so
 * both stages judge availability with the same rule.
 *
 * `collectionDate` / `deliveryDate` are DATETIME columns whose time part is not
 * meaningful — the slot is carried by the separate TIME columns — so date
 * matching compares on DATE() only.
 */
const { Op, fn, col, where: sequelizeWhere } = require('sequelize');
const { booking } = require('../models');
const { SLOT_RELEASING } = require('../constants/bookingStatusIds');

/** Columns backing each schedule leg of a booking. */
const LEGS = [
    {
        dateColumn: 'collectionDate',
        fromColumn: 'collectionTimeFrom',
        toColumn: 'collectionTimeTo',
    },
    {
        dateColumn: 'deliveryDate',
        fromColumn: 'deliveryTimeFrom',
        toColumn: 'deliveryTimeTo',
    },
];

/**
 * `YYYY-MM-DD` in the calendar the value was stored in. Sequelize hands back a
 * Date built from the connection timezone, so read local parts rather than
 * going through toISOString(), which would shift the day either side of UTC.
 */
function toDateOnly(value) {
    if (!value) return null;

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    const text = String(value).trim();
    const leadingDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (leadingDate) return leadingDate[1];

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : toDateOnly(parsed);
}

/** `HH:MM` and `HH:MM:SS` both arrive from clients; normalise to `HH:MM:SS`. */
function toTimeOnly(value) {
    if (!value) return null;

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const hours = String(value.getHours()).padStart(2, '0');
        const minutes = String(value.getMinutes()).padStart(2, '0');
        const seconds = String(value.getSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    const match = String(value)
        .trim()
        .match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;

    const hours = String(Number(match[1])).padStart(2, '0');
    return `${hours}:${match[2]}:${match[3] || '00'}`;
}

/**
 * Half-open overlap: two windows clash when each starts before the other ends.
 * Back-to-back slots (10:00–11:00 then 11:00–12:00) therefore do not clash.
 */
function buildLegClause(leg, date, from, to) {
    const day = toDateOnly(date);
    const start = toTimeOnly(from);
    const end = toTimeOnly(to);
    if (!day || !start || !end) return null;

    return {
        [Op.and]: [
            sequelizeWhere(fn('DATE', col(leg.dateColumn)), day),
            { [leg.fromColumn]: { [Op.lt]: end } },
            { [leg.toColumn]: { [Op.gt]: start } },
        ],
    };
}

/**
 * Bookings already on this shop's schedule that clash with the requested
 * window. A leg with incomplete date/time input is simply not checked.
 *
 * @param {number} shopAddressId `addressDb.id` of the laundry shop.
 * @param {object} window Requested collection/delivery date and time range.
 * @param {{excludeBookingId?: number}} [options]
 * @returns {Promise<object[]>} Up to a handful of clashing bookings.
 */
async function findShopSlotConflicts(shopAddressId, window = {}, options = {}) {
    const shopId = Number(shopAddressId);
    if (!Number.isFinite(shopId) || shopId <= 0) return [];

    const legClauses = [
        buildLegClause(
            LEGS[0],
            window.collectionDate,
            window.collectionTimeFrom,
            window.collectionTimeTo
        ),
        buildLegClause(
            LEGS[1],
            window.deliveryDate,
            window.deliveryTimeFrom,
            window.deliveryTimeTo
        ),
    ].filter(Boolean);

    // Nothing usable to compare against — treat the shop as free rather than
    // silently blocking every shop in the zone.
    if (!legClauses.length) return [];

    const criteria = {
        laundryShopId: shopId,
        bookingStatusId: { [Op.notIn]: SLOT_RELEASING },
        [Op.or]: legClauses,
    };

    const excludeBookingId = Number(options.excludeBookingId);
    if (Number.isFinite(excludeBookingId) && excludeBookingId > 0) {
        criteria.id = { [Op.ne]: excludeBookingId };
    }

    return booking.findAll({
        where: criteria,
        attributes: [
            'id',
            'bookingStatusId',
            'collectionDate',
            'collectionTimeFrom',
            'collectionTimeTo',
            'deliveryDate',
            'deliveryTimeFrom',
            'deliveryTimeTo',
        ],
        limit: 5,
    });
}

/** Convenience wrapper for callers that only need a yes/no. */
async function isShopSlotFree(shopAddressId, window = {}, options = {}) {
    const conflicts = await findShopSlotConflicts(
        shopAddressId,
        window,
        options
    );
    return conflicts.length === 0;
}

module.exports = {
    findShopSlotConflicts,
    isShopSlotFree,
    toDateOnly,
    toTimeOnly,
};
