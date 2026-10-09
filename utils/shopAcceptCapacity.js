'use strict';

/**
 * Shop accept capacity settings.
 *
 * Global: runtime settings shopAcceptCapEnabled / shopAcceptMaxOrders.
 * Per shop: shopAssignmentPolicies.acceptCapOverride + acceptMaxOrders.
 * The limit is applied per booking slot (pickups + deliveries in that hour) by
 * utils/shopSlotCapacity.js. The rolling-window helpers below (countRecentAccepts,
 * evaluateShopAcceptCapacity) are no longer used for routing or accepting.
 * Admin manual assign always bypasses. Overflow simply goes to other eligible shops.
 */

const { Op } = require('sequelize');
const { booking, bookingHistory } = require('../models');

const ACCEPTED_STATUS_ID = 3;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Resolve effective cap for a shop owner user id.
 * @returns {Promise<{enabled:boolean, windowMinutes:number, maxOrders:number|null, source:string}>}
 */
async function resolveAcceptCapForShop(shopUserId) {
  const runtimeSettings = require('../services/Admin/runtimeSettingsService');
  const shopAssignmentPolicyService = require('../services/Admin/shopAssignmentPolicyService');

  const globalEnabled = await runtimeSettings.getBoolean('shopAcceptCapEnabled');
  const globalWindow = clampInt(
    await runtimeSettings.getInteger('shopAcceptWindowMinutes'),
    1,
    24 * 60,
    60
  );
  const globalMax = clampInt(
    await runtimeSettings.getInteger('shopAcceptMaxOrders'),
    0,
    500,
    4
  );

  let policy = null;
  try {
    policy = await shopAssignmentPolicyService.getPolicy(shopUserId);
  } catch (_err) {
    policy = null;
  }

  if (policy?.acceptCapOverride) {
    const windowMinutes = clampInt(
      policy.acceptWindowMinutes,
      1,
      24 * 60,
      globalWindow
    );
    const maxOrders = clampInt(policy.acceptMaxOrders, 0, 500, 0);
    return {
      enabled: true,
      windowMinutes,
      maxOrders,
      source: 'shop',
    };
  }

  if (!globalEnabled) {
    return {
      enabled: false,
      windowMinutes: globalWindow,
      maxOrders: null,
      source: 'off',
    };
  }

  return {
    enabled: true,
    windowMinutes: globalWindow,
    maxOrders: globalMax,
    source: 'global',
  };
}

/**
 * Count marketplace/admin accepts for a shop address in the rolling window.
 * Uses bookingHistory status=3 (Accepted) joined to current laundryShopId.
 */
async function countRecentAccepts(shopAddressId, windowMinutes, options = {}) {
  const shopId = Number(shopAddressId);
  if (!Number.isFinite(shopId) || shopId <= 0) return 0;
  const mins = clampInt(windowMinutes, 1, 24 * 60, 60);
  const since = new Date(Date.now() - mins * 60 * 1000);
  const excludeBookingId = Number(options.excludeBookingId);

  const whereHistory = {
    bookingStatusId: ACCEPTED_STATUS_ID,
    createdAt: { [Op.gte]: since },
  };

  const bookingWhere = {
    laundryShopId: shopId,
  };
  if (Number.isFinite(excludeBookingId) && excludeBookingId > 0) {
    bookingWhere.id = { [Op.ne]: excludeBookingId };
  }

  try {
    const count = await bookingHistory.count({
      where: whereHistory,
      include: [
        {
          model: booking,
          required: true,
          attributes: [],
          where: bookingWhere,
        },
      ],
      distinct: true,
      col: 'bookingId',
    });
    return Number(count) || 0;
  } catch (err) {
    // Fallback if association missing: raw bookings updated in window.
    console.warn(
      '[shopAcceptCapacity] history count failed, using booking.updatedAt:',
      err?.message || err
    );
    const count = await booking.count({
      where: {
        laundryShopId: shopId,
        updatedAt: { [Op.gte]: since },
        bookingStatusId: { [Op.gte]: ACCEPTED_STATUS_ID },
        ...(Number.isFinite(excludeBookingId) && excludeBookingId > 0
          ? { id: { [Op.ne]: excludeBookingId } }
          : {}),
      },
    });
    return Number(count) || 0;
  }
}

/**
 * @returns {Promise<{allowed:boolean, acceptedInWindow:number, cap:object, reason?:string}>}
 */
async function evaluateShopAcceptCapacity(shopUserId, shopAddressId, options = {}) {
  const cap = await resolveAcceptCapForShop(shopUserId);
  if (!cap.enabled) {
    return { allowed: true, acceptedInWindow: 0, cap };
  }

  if (cap.maxOrders === 0) {
    return {
      allowed: false,
      acceptedInWindow: 0,
      cap,
      reason: 'accept_cap_zero',
    };
  }

  const acceptedInWindow = await countRecentAccepts(
    shopAddressId,
    cap.windowMinutes,
    options
  );

  if (acceptedInWindow >= cap.maxOrders) {
    return {
      allowed: false,
      acceptedInWindow,
      cap,
      reason: 'accept_cap_reached',
    };
  }

  return { allowed: true, acceptedInWindow, cap };
}

/**
 * One accept timestamp per booking in the rolling window (oldest first).
 * Used to compute when the next slot frees.
 */
async function listRecentAcceptTimes(shopAddressId, windowMinutes, options = {}) {
  const shopId = Number(shopAddressId);
  if (!Number.isFinite(shopId) || shopId <= 0) return [];
  const mins = clampInt(windowMinutes, 1, 24 * 60, 60);
  const since = new Date(Date.now() - mins * 60 * 1000);
  const excludeBookingId = Number(options.excludeBookingId);

  const bookingWhere = { laundryShopId: shopId };
  if (Number.isFinite(excludeBookingId) && excludeBookingId > 0) {
    bookingWhere.id = { [Op.ne]: excludeBookingId };
  }

  try {
    const rows = await bookingHistory.findAll({
      attributes: ['bookingId', 'createdAt'],
      where: {
        bookingStatusId: ACCEPTED_STATUS_ID,
        createdAt: { [Op.gte]: since },
      },
      include: [
        {
          model: booking,
          required: true,
          attributes: [],
          where: bookingWhere,
        },
      ],
      order: [['createdAt', 'ASC']],
    });
    const byBooking = new Map();
    for (const row of rows) {
      const id = row.bookingId;
      if (id == null || byBooking.has(id)) continue;
      byBooking.set(id, row.createdAt);
    }
    return [...byBooking.values()];
  } catch (err) {
    console.warn(
      '[shopAcceptCapacity] list accept times failed, using booking.updatedAt:',
      err?.message || err
    );
    const rows = await booking.findAll({
      attributes: ['id', 'updatedAt'],
      where: {
        laundryShopId: shopId,
        updatedAt: { [Op.gte]: since },
        bookingStatusId: { [Op.gte]: ACCEPTED_STATUS_ID },
        ...(Number.isFinite(excludeBookingId) && excludeBookingId > 0
          ? { id: { [Op.ne]: excludeBookingId } }
          : {}),
      },
      order: [['updatedAt', 'ASC']],
    });
    return rows.map((r) => r.updatedAt);
  }
}

/**
 * Client snapshot for the agent banner / acceptCapacity GET / socket push / admin.
 *
 * Capacity is per booking slot now (utils/shopSlotCapacity.js). The old rolling
 * fields stay in the response but switched off, so agent app builds that only
 * know the rolling window never count or block locally (the server still
 * refuses an accept into a full slot). New clients read `slotCapacity`.
 */
async function getShopAcceptCapacityStatus(shopUserId) {
  const { listUpcomingSlotLoad } = require('./shopSlotCapacity');
  const { addressDb } = require('../models');

  const cap = await resolveAcceptCapForShop(shopUserId);
  const limit = cap.enabled ? Number(cap.maxOrders) || 0 : 1;
  const shopAddress = await addressDb.findOne({
    where: { userId: shopUserId, addressType: 'LaundaryShopAddress' },
    attributes: ['id'],
  });
  const upcoming = shopAddress ? await listUpcomingSlotLoad(shopAddress.id) : [];

  return {
    enabled: false,
    limit: null,
    used: 0,
    remaining: null,
    windowMinutes: null,
    atCapacity: false,
    resetsAt: null,
    resetsInSeconds: null,
    slotCapacity: {
      enabled: cap.enabled,
      mode: cap.enabled ? 'slot' : 'single',
      limit,
      source: cap.source,
      summary: cap.enabled
        ? limit === 0
          ? 'Capacity 0: no marketplace orders (admin can still assign).'
          : `Up to ${limit} pickups and deliveries per slot.`
        : 'One order per pickup / delivery slot.',
      upcoming: upcoming.map((r) => ({ ...r, limit, full: r.used >= limit })),
    },
  };
}

module.exports = {
  resolveAcceptCapForShop,
  countRecentAccepts,
  listRecentAcceptTimes,
  evaluateShopAcceptCapacity,
  getShopAcceptCapacityStatus,
  ACCEPTED_STATUS_ID,
};
