'use strict';

/**
 * Slot-wise shop capacity.
 *
 * A shop may hold up to N jobs in one booking slot (e.g. 11:00–12:00), where a
 * job is a pickup or a delivery the shop already has in that hour. N is the
 * admin setting "max orders" — global (runtime settings) or the shop's own
 * override. A new booking needs room in its pickup slot AND its delivery slot,
 * so bookings for other slots, days or future dates never use each other's room.
 *
 * Capacity switched off (no global setting, no shop override) keeps the old rule:
 * one booking per pickup / delivery window (shopSlotAvailability.isShopSlotFree).
 * Admin manual assign bypasses this (callers skip the check).
 */

const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { booking } = require('../models');
const { SLOT_RELEASING } = require('../constants/bookingStatusIds');
const { toDateOnly, toTimeOnly, isShopSlotFree } = require('./shopSlotAvailability');
const { resolveAcceptCapForShop } = require('./shopAcceptCapacity');

const SLOT_FULL_CODE = 'SHOP_SLOT_FULL';

const LEG_COLUMNS = {
  pickup: { date: 'collectionDate', from: 'collectionTimeFrom', to: 'collectionTimeTo' },
  delivery: { date: 'deliveryDate', from: 'deliveryTimeFrom', to: 'deliveryTimeTo' },
};

/** { day, start, end } in DB form, or null when the input is incomplete. */
function slotOf(date, from, to) {
  const day = toDateOnly(date);
  const start = toTimeOnly(from);
  const end = toTimeOnly(to);
  if (!day || !start || !end || start === end) return null;
  return { day, start, end };
}

/** The pickup and delivery slots a booking asks for (missing legs left out). */
function requestedSlots(request = {}) {
  const out = [];
  const pickup = slotOf(request.collectionDate, request.collectionTimeFrom, request.collectionTimeTo);
  const delivery = slotOf(request.deliveryDate, request.deliveryTimeFrom, request.deliveryTimeTo);
  if (pickup) out.push({ leg: 'pickup', ...pickup });
  if (delivery) out.push({ leg: 'delivery', ...delivery });
  return out;
}

/**
 * Jobs the shop already has in a slot: pickups + deliveries whose window
 * overlaps it (half-open, so back-to-back slots do not clash). Cancelled,
 * refunded and completed bookings free their room.
 */
async function countJobsInSlot(shopAddressId, slot, options = {}) {
  const shopId = Number(shopAddressId);
  if (!Number.isFinite(shopId) || shopId <= 0 || !slot) return { pickups: 0, deliveries: 0, total: 0 };
  const excludeBookingId = Number(options.excludeBookingId);
  const base = {
    laundryShopId: shopId,
    bookingStatusId: { [Op.notIn]: SLOT_RELEASING },
    ...(Number.isFinite(excludeBookingId) && excludeBookingId > 0 ? { id: { [Op.ne]: excludeBookingId } } : {}),
  };
  const legWhere = (c) => ({
    ...base,
    [Op.and]: [
      sqlWhere(fn('DATE', col(c.date)), slot.day),
      { [c.from]: { [Op.lt]: slot.end } },
      { [c.to]: { [Op.gt]: slot.start } },
    ],
  });
  const [pickups, deliveries] = await Promise.all([
    booking.count({ where: legWhere(LEG_COLUMNS.pickup), transaction: options.transaction }),
    booking.count({ where: legWhere(LEG_COLUMNS.delivery), transaction: options.transaction }),
  ]);
  return { pickups, deliveries, total: pickups + deliveries };
}

/**
 * Can this shop take a booking in the requested pickup / delivery slots?
 *
 * @param {number} shopUserId shop owner user id (for the capacity setting)
 * @param {number} shopAddressId shop address id (bookings.laundryShopId)
 * @param {object} request collectionDate/TimeFrom/TimeTo + deliveryDate/TimeFrom/TimeTo
 * @param {{ excludeBookingId?: number, transaction?: object, cap?: object }} [options]
 *   cap: an already resolved resolveAcceptCapForShop() result (lists check many orders)
 * @returns {Promise<{ allowed: boolean, mode: 'slot'|'single', reason: string|null,
 *   limit: number|null, source: string, slots: Array<{ leg, date, from, to, used, limit, full }> }>}
 */
async function evaluateShopSlotCapacity(shopUserId, shopAddressId, request = {}, options = {}) {
  const cap = options.cap || (await resolveAcceptCapForShop(shopUserId));

  if (!cap.enabled) {
    const free = await isShopSlotFree(shopAddressId, request, { excludeBookingId: options.excludeBookingId });
    return { allowed: free, mode: 'single', reason: free ? null : 'slot_taken', limit: 1, source: cap.source, slots: [] };
  }

  const limit = Number(cap.maxOrders) || 0;
  if (limit === 0) {
    return { allowed: false, mode: 'slot', reason: 'accept_cap_zero', limit: 0, source: cap.source, slots: [] };
  }

  // Pickup and delivery in the very same slot need two places in it.
  const groups = new Map();
  for (const s of requestedSlots(request)) {
    const key = `${s.day}|${s.start}|${s.end}`;
    const g = groups.get(key) || { ...s, legs: [], need: 0 };
    g.legs.push(s.leg);
    g.need += 1;
    groups.set(key, g);
  }

  const slots = [];
  for (const g of groups.values()) {
    const used = (await countJobsInSlot(shopAddressId, g, options)).total;
    slots.push({
      leg: g.legs.join('+'),
      date: g.day,
      from: g.start.slice(0, 5),
      to: g.end.slice(0, 5),
      used,
      limit,
      full: used + g.need > limit,
    });
  }
  const full = slots.some((s) => s.full);
  return { allowed: !full, mode: 'slot', reason: full ? 'slot_full' : null, limit, source: cap.source, slots };
}

/** "Mon 12 Oct" from "2026-10-12" (no timezone shift: the date is already local). */
function formatSlotDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return String(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

/** Plain-words reason for an agent when a slot has no room. */
function slotFullMessage(result) {
  if (!result || result.allowed) return null;
  if (result.reason === 'accept_cap_zero') {
    return 'Your shop cannot accept marketplace orders right now (capacity set to 0). Contact support.';
  }
  if (result.reason === 'slot_taken') {
    return 'You already have an order in this pickup or delivery slot. Choose another order.';
  }
  const fullSlot = result.slots.find((s) => s.full);
  if (!fullSlot) return 'This slot is full for your shop.';
  const legText = fullSlot.leg === 'pickup' ? 'pickup' : fullSlot.leg === 'delivery' ? 'delivery' : 'pickup and delivery';
  return `Your ${legText} slot ${formatSlotDay(fullSlot.date)} ${fullSlot.from}–${fullSlot.to} is full ` +
    `(${fullSlot.used} of ${fullSlot.limit} pickups and deliveries). You can take orders in other slots.`;
}

/**
 * Upcoming slot load for a shop (agent banner, admin shop view): every slot from
 * today on that already has pickups or deliveries, soonest first.
 */
async function listUpcomingSlotLoad(shopAddressId, { fromDay, limitRows = 30 } = {}) {
  const shopId = Number(shopAddressId);
  if (!Number.isFinite(shopId) || shopId <= 0) return [];
  const today = fromDay || toDateOnly(new Date());
  const rows = await booking.findAll({
    where: {
      laundryShopId: shopId,
      bookingStatusId: { [Op.notIn]: SLOT_RELEASING },
      [Op.or]: [
        sqlWhere(fn('DATE', col('collectionDate')), { [Op.gte]: today }),
        sqlWhere(fn('DATE', col('deliveryDate')), { [Op.gte]: today }),
      ],
    },
    attributes: ['id', 'collectionDate', 'collectionTimeFrom', 'collectionTimeTo', 'deliveryDate', 'deliveryTimeFrom', 'deliveryTimeTo'],
  });
  const bySlot = new Map();
  const add = (leg, s) => {
    if (!s || s.day < today) return;
    const key = `${s.day}|${s.start}|${s.end}`;
    const row = bySlot.get(key) || { date: s.day, from: s.start.slice(0, 5), to: s.end.slice(0, 5), pickups: 0, deliveries: 0 };
    row[leg === 'pickup' ? 'pickups' : 'deliveries'] += 1;
    bySlot.set(key, row);
  };
  for (const b of rows) {
    add('pickup', slotOf(b.collectionDate, b.collectionTimeFrom, b.collectionTimeTo));
    add('delivery', slotOf(b.deliveryDate, b.deliveryTimeFrom, b.deliveryTimeTo));
  }
  return [...bySlot.values()]
    .map((r) => ({ ...r, used: r.pickups + r.deliveries }))
    .sort((a, b) => (a.date === b.date ? a.from.localeCompare(b.from) : a.date.localeCompare(b.date)))
    .slice(0, limitRows);
}

module.exports = {
  SLOT_FULL_CODE,
  requestedSlots,
  countJobsInSlot,
  evaluateShopSlotCapacity,
  slotFullMessage,
  formatSlotDay,
  listUpcomingSlotLoad,
};
