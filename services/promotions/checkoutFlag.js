'use strict';

/**
 * Kill switch for promotions at booking and invoice (docs/PROMOTIONS_CHECKOUT_PLAN.md).
 *
 *   PROMOTIONS_CHECKOUT_ENABLED=true        turn it on (anything else = off, today's behaviour)
 *   PROMOTIONS_CHECKOUT_ZONE_IDS=3,7        optional: only these zones (blank = every zone)
 *
 * Read on every call so ops can flip it with a restart and no deploy.
 */

function isPromotionsCheckoutEnabled(zoneId, env = process.env) {
  if (String(env.PROMOTIONS_CHECKOUT_ENABLED || '').trim().toLowerCase() !== 'true') return false;
  const allow = String(env.PROMOTIONS_CHECKOUT_ZONE_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!allow.length) return true;
  return allow.includes(Number(zoneId));
}

module.exports = { isPromotionsCheckoutEnabled };
