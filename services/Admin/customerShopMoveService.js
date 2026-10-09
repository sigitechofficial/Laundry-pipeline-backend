'use strict';

/**
 * What happens to a customer's open orders when an admin moves the customer to
 * another shop, excludes them from a shop, or clears the assignment:
 *  - orders still waiting for a shop are routed again (the new preferred shop
 *    gets the head-start window; an excluded shop is never offered them);
 *  - orders a shop already accepted (Confirmed / Awaiting collection) are not
 *    moved silently — they are returned so the admin can reassign them.
 */

const { Op } = require('sequelize');
const { booking } = require('../../models');

/** Accepted, not yet collected — still reassignable by an admin. */
const REASSIGNABLE_STATUSES = [2, 3];

async function reroutePendingOrders(customerId) {
  const rows = await booking.findAll({
    where: {
      customerId: Number(customerId),
      bookingStatusId: 1,
      laundryShopId: null,
      agentBroadcastHeld: { [Op.not]: true },
    },
    attributes: ['id'],
  });
  const { routePendingBooking } = require('../Customer/customerOrderService');
  const rerouted = [];
  for (const { id } of rows) {
    try {
      const r = await routePendingBooking(id);
      rerouted.push({ bookingId: id, mode: r.mode, notifiedCount: r.notifiedCount || 0 });
    } catch (err) {
      console.warn(`[customerShopMove] reroute of booking ${id} failed:`, err?.message || err);
    }
  }
  return rerouted;
}

/** Accepted open orders held by any shop other than keepShopAddressId. */
async function acceptedOrdersElsewhere(customerId, { keepShopAddressId = null, onlyShopAddressId = null } = {}) {
  const where = {
    customerId: Number(customerId),
    bookingStatusId: REASSIGNABLE_STATUSES,
    laundryShopId: onlyShopAddressId != null
      ? Number(onlyShopAddressId)
      : keepShopAddressId != null
        ? { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: Number(keepShopAddressId) }] }
        : { [Op.ne]: null },
  };
  const rows = await booking.findAll({
    where,
    attributes: ['id', 'orderTrackId', 'bookingStatusId', 'laundryShopId', 'collectionDate', 'collectionTimeFrom'],
    order: [['collectionDate', 'ASC']],
    limit: 20,
  });
  return rows.map((b) => ({
    bookingId: b.id,
    orderTrackId: b.orderTrackId,
    bookingStatusId: b.bookingStatusId,
    laundryShopId: b.laundryShopId,
    collectionDate: b.collectionDate,
    collectionTimeFrom: b.collectionTimeFrom,
  }));
}

/**
 * @param {number} customerId
 * @param {{ keepShopAddressId?: number, onlyShopAddressId?: number }} options
 *   keepShopAddressId: the customer's new shop (orders there are fine);
 *   onlyShopAddressId: list only orders at this shop (exclusion).
 */
async function applyCustomerShopMove(customerId, options = {}) {
  const rerouted = await reroutePendingOrders(customerId);
  const stillWithOtherShop = await acceptedOrdersElsewhere(customerId, options);
  return { rerouted, stillWithOtherShop };
}

module.exports = { applyCustomerShopMove, reroutePendingOrders, acceptedOrdersElsewhere };
