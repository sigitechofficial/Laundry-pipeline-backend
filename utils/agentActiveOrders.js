'use strict';

/**
 * Single source of truth for "orders the agent has accepted and is still
 * responsible for" — i.e. active, in-progress work that has NOT been completed,
 * cancelled/refunded, or reassigned to another shop by admin.
 *
 * These status IDs mirror AGENT_ALL_ACTIVE_STATUSES in controllers/Agent/agents.js:
 *   3-7   pickup pipeline (awaiting collection → in transit to facility)
 *   8-9   at shop / invoice being built
 *   10-11 invoice generated + washing (processing)
 *   12-16 facility complete → out for delivery → delivered-pending
 *
 * A reassigned booking gets a different laundryShopId, so it naturally drops
 * out of this filter for the original agent. Terminal statuses (17 Completed,
 * 19 Cancelled, 21 Refunded, 23 Issue Resolved) and on-hold (18, 24) are
 * excluded, as is the brand-new / unaccepted pool (status 1).
 */

const { Op } = require('sequelize');
const { booking, addressDb } = require('../models');

const AGENT_ACTIVE_ORDER_STATUSES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** Resolve the agent's own laundry-shop address id (bookings.laundryShopId FK). */
async function resolveShopAddressId(agentUserId) {
    const row = await addressDb.findOne({
        where: {
            userId: Number(agentUserId),
            addressType: 'LaundaryShopAddress',
            deletedAt: null,
        },
        attributes: ['id'],
    });
    return row?.id || null;
}

/** Count active accepted orders assigned to this agent's shop. */
async function countActiveAssignedOrders(agentUserId, shopAddressId = null) {
    const shopId = shopAddressId || (await resolveShopAddressId(agentUserId));
    if (!shopId) return 0;
    return booking.count({
        where: {
            laundryShopId: Number(shopId),
            bookingStatusId: { [Op.in]: AGENT_ACTIVE_ORDER_STATUSES },
        },
    });
}

/** List active accepted orders (lightweight) for surfacing in a warning dialog. */
async function listActiveAssignedOrders(agentUserId, shopAddressId = null, limit = 50) {
    const shopId = shopAddressId || (await resolveShopAddressId(agentUserId));
    if (!shopId) return [];
    const rows = await booking.findAll({
        where: {
            laundryShopId: Number(shopId),
            bookingStatusId: { [Op.in]: AGENT_ACTIVE_ORDER_STATUSES },
        },
        attributes: ['id', 'orderTrackId', 'bookingStatusId', 'collectionDate', 'deliveryDate'],
        order: [['id', 'DESC']],
        limit,
    });
    return rows.map((row) => (row.toJSON ? row.toJSON() : row));
}

module.exports = {
    AGENT_ACTIVE_ORDER_STATUSES,
    resolveShopAddressId,
    countActiveAssignedOrders,
    listActiveAssignedOrders,
};
