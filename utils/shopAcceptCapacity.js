'use strict';

/**
 * Shop accept capacity — rolling window rate limit for marketplace accepts.
 *
 * Global defaults: runtime settings shopAcceptCapEnabled / WindowMinutes / MaxOrders.
 * Per-shop override: shopAssignmentPolicies.acceptCapOverride + window + max.
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

module.exports = {
  resolveAcceptCapForShop,
  countRecentAccepts,
  evaluateShopAcceptCapacity,
  ACCEPTED_STATUS_ID,
};
