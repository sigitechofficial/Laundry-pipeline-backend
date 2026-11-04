'use strict';

/**
 * New-shop order ramp.
 * 1st order: 100% of laundry after discount to admin.
 * 2nd: 50% admin / 50% shop.
 * 3rd: 100% shop.
 * 4th onwards: the zone's normal commission, on today's pre-discount base.
 * Driver tip stays with the shop. Service fee stays with the platform.
 */

function uniqueZoneIds(list) {
  const out = [];
  const seen = new Set();
  const source = Array.isArray(list) ? list : [];
  for (const item of source) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 200) break;
  }
  return out;
}

function parseZoneIds(value) {
  if (Array.isArray(value)) return uniqueZoneIds(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return uniqueZoneIds(parsed);
    } catch (_) {
      /* comma-separated fallback */
    }
    return uniqueZoneIds(trimmed.split(','));
  }
  return [];
}

function isPolicyActiveForZone(settings, zoneId) {
  if (!settings?.enabled) return false;
  if (settings.applyToAllZones) return true;
  const id = Number(zoneId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return parseZoneIds(settings.zoneIds).includes(id);
}

/**
 * Percents frozen onto the booking. Step 4+ keeps the live zone percents.
 */
function percentsForStep(step, live) {
  const agentLive = Number(live?.agentCommissionPercent) || 0;
  const platformLive = Number(live?.platformCommissionPercent);
  const platform =
    Number.isFinite(platformLive) ? platformLive : Math.max(0, 100 - agentLive);
  const n = Number(step);
  if (n === 1) {
    return { agentCommissionPercent: 0, platformCommissionPercent: 100, revenueRampStep: 1 };
  }
  if (n === 2) {
    return { agentCommissionPercent: 50, platformCommissionPercent: 50, revenueRampStep: 2 };
  }
  if (n === 3) {
    return { agentCommissionPercent: 100, platformCommissionPercent: 0, revenueRampStep: 3 };
  }
  return {
    agentCommissionPercent: agentLive,
    platformCommissionPercent: platform,
    revenueRampStep: Number.isInteger(n) && n > 0 ? n : null,
  };
}

/**
 * First three ramp orders split laundry after discount.
 * Later orders, and every non-ramp order, keep the base unchanged.
 */
function rampCommissionBase(commissionBase, discount, step) {
  const amount = Number(commissionBase) || 0;
  const n = Number(step);
  if (n !== 1 && n !== 2 && n !== 3) {
    return parseFloat(amount.toFixed(2));
  }
  const off = Math.max(0, Number(discount) || 0);
  return parseFloat(Math.max(0, amount - off).toFixed(2));
}

module.exports = {
  uniqueZoneIds,
  parseZoneIds,
  isPolicyActiveForZone,
  percentsForStep,
  rampCommissionBase,
};
