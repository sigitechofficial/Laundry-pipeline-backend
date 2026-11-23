'use strict';

/**
 * The currency of a booking is its zone's currency (zones.currencyUnitId -> units).
 * Policies (no-show, cancellation) may name their own currency; when they do not, or
 * when no policy exists, amounts are in the zone currency — never a hard-coded one
 * (fees used to fall back to 'USD' in GBP zones).
 *
 * Resolution and the platform-wide last resort live in resolveDisplayCurrency.
 */
const { resolveDisplayCurrency } = require('./resolveDisplayCurrency');

/** @returns {Promise<{ currencySymbol: string, currencyCode: string }>} */
function zoneCurrency(zoneId) {
  return resolveDisplayCurrency({ zoneId });
}

/** ISO code (e.g. "GBP") of the zone's currency. */
async function zoneCurrencyCode(zoneId) {
  return (await zoneCurrency(zoneId)).currencyCode;
}

/** ISO code of a booking's currency (looked up through its zone). */
async function bookingCurrencyCode(bookingId) {
  const { booking } = require('../models');
  const row = await booking.findByPk(bookingId, { attributes: ['zoneId'], paranoid: false });
  return zoneCurrencyCode(row?.zoneId);
}

module.exports = { zoneCurrency, zoneCurrencyCode, bookingCurrencyCode };
