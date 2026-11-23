'use strict';

/**
 * Pure rolling-window math for shop accept capacity (no DB access, unit-tested).
 */

const moment = require('moment-timezone');
const { requireOperationalTimeZone } = require('./bookingTimeZone');

const CAPACITY_REACHED_CODE = 'SHOP_ACCEPT_CAP_REACHED';

/**
 * When the window next has room: the moment enough counted accepts age out.
 * @param {Array<Date|string|number>} acceptTimes one timestamp per counted booking
 * @returns {Date|null} null when there is room now, or the cap is 0 (never frees by itself)
 */
function computeCapacityResetAt(acceptTimes, maxOrders, windowMinutes) {
  if (!Number.isFinite(maxOrders) || maxOrders <= 0) return null;
  const times = (acceptTimes || [])
    .map((t) => new Date(t).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < maxOrders) return null;
  const mustExpire = times.length - maxOrders + 1;
  return new Date(times[mustExpire - 1] + windowMinutes * 60 * 1000);
}

/**
 * Client-facing capacity snapshot (agent app banner, toasts, socket pushes).
 */
function buildCapacityStatus({ cap, used = 0, resetsAt = null, now = Date.now() }) {
  if (!cap?.enabled) {
    return {
      enabled: false,
      limit: null,
      used: 0,
      remaining: null,
      windowMinutes: cap?.windowMinutes ?? null,
      atCapacity: false,
      resetsAt: null,
      resetsInSeconds: null,
    };
  }
  const limit = Number(cap.maxOrders) || 0;
  const atCapacity = used >= limit;
  const resetMs = resetsAt ? new Date(resetsAt).getTime() : null;
  return {
    enabled: true,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    windowMinutes: cap.windowMinutes,
    atCapacity,
    resetsAt: atCapacity && resetMs ? new Date(resetMs).toISOString() : null,
    resetsInSeconds:
      atCapacity && resetMs ? Math.max(0, Math.ceil((resetMs - now) / 1000)) : null,
  };
}

/** "HH:mm" of an instant on the shop's clock (its operational IANA zone). */
function formatClock(date, timeZone) {
  return moment(new Date(date)).tz(requireOperationalTimeZone(timeZone, 'the shop')).format('HH:mm');
}

/**
 * @param {object} status
 * @param {string} timeZone the shop's operational IANA zone (requireShopTimeZone)
 */
function capacityReachedMessage(status, timeZone) {
  if (!status?.limit) {
    return 'Your shop cannot accept marketplace orders right now (limit set to 0). Contact support.';
  }
  const base = `You have reached your limit of ${status.limit} orders in ${status.windowMinutes} minutes.`;
  if (!status.resetsAt) return `${base} Try again shortly.`;
  const mins = Math.max(1, Math.ceil((status.resetsInSeconds || 0) / 60));
  return `${base} You can accept again at ${formatClock(status.resetsAt, timeZone)} (in ${mins} min).`;
}

module.exports = {
  CAPACITY_REACHED_CODE,
  computeCapacityResetAt,
  buildCapacityStatus,
  capacityReachedMessage,
  formatClock,
};
