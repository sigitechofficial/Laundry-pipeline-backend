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

/** A booking's currency (looked up through its zone). */
async function bookingCurrency(bookingId) {
  const { booking } = require('../models');
  const row = await booking.findByPk(bookingId, { attributes: ['zoneId'], paranoid: false });
  return zoneCurrency(row?.zoneId);
}

/** ISO code of a booking's currency (looked up through its zone). */
async function bookingCurrencyCode(bookingId) {
  return (await bookingCurrency(bookingId)).currencyCode;
}

/**
 * Currency of a shop's own money (wallet, withdrawals, settlements, the shop app):
 * the zone of its LaundaryShopAddress. A shop with no zone yet (registration in
 * progress) gets the platform default from resolveDisplayCurrency.
 * @param {number|string} shopOwnerUserId the shop owner (an employee's employeeOff)
 * @returns {Promise<{ currencySymbol: string, currencyCode: string }>}
 */
async function shopCurrency(shopOwnerUserId) {
  const { addressDb } = require('../models');
  const shopAddress = shopOwnerUserId
    ? await addressDb.findOne({
        where: { userId: shopOwnerUserId, addressType: 'LaundaryShopAddress' },
        attributes: ['id', 'zoneId'],
      })
    : null;
  return zoneCurrency(shopAddress?.zoneId);
}

/** ISO code of a shop's currency (see shopCurrency). */
async function shopCurrencyCode(shopOwnerUserId) {
  return (await shopCurrency(shopOwnerUserId)).currencyCode;
}

module.exports = {
  zoneCurrency,
  zoneCurrencyCode,
  bookingCurrency,
  bookingCurrencyCode,
  shopCurrency,
  shopCurrencyCode,
};
