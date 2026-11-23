'use strict';

/**
 * Booking / shop currency comes from the zone (models stubbed).
 *   node utils/zoneCurrency.test.js
 */

const assert = require('assert/strict');
const path = require('path');

const EUR_ZONE = 7;
const UNITLESS_ZONE = 8;
const zones = {
  [EUR_ZONE]: { id: EUR_ZONE, cityId: null, currencyUnitZ: { symbol: '€', name: 'EUR' } },
  [UNITLESS_ZONE]: { id: UNITLESS_ZONE, cityId: null, currencyUnitZ: null },
};
const FIRST_ACTIVE_ZONE = { id: 1, currencyUnitZ: { symbol: '£', name: 'GBP' } };
const shops = { 11: { id: 50, zoneId: EUR_ZONE }, 12: { id: 51, zoneId: null } };
const addressQueries = [];

const models = {
  zone: {
    findByPk: async (id) => zones[id] || null,
    findOne: async () => FIRST_ACTIVE_ZONE, // resolveDisplayCurrency's "first active zone"
    findAll: async () => [],
  },
  units: {},
  cities: { findByPk: async () => null, findAll: async () => [] },
  countries: { findByPk: async () => null },
  booking: { findByPk: async (id) => (id === 900 ? { zoneId: EUR_ZONE } : null) },
  addressDb: {
    findOne: async ({ where }) => {
      addressQueries.push(where);
      return shops[where.userId] || null;
    },
  },
};
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: models };

const {
  zoneCurrency,
  zoneCurrencyCode,
  bookingCurrencyCode,
  shopCurrency,
  shopCurrencyCode,
} = require('./zoneCurrency');

(async () => {
  assert.deepEqual(await zoneCurrency(EUR_ZONE), { currencySymbol: '€', currencyCode: 'EUR' });
  assert.equal(await zoneCurrencyCode(EUR_ZONE), 'EUR');
  assert.equal(await bookingCurrencyCode(900), 'EUR', 'a booking is in its zone currency');

  // Shop money: the zone of the shop's LaundaryShopAddress.
  assert.deepEqual(await shopCurrency(11), { currencySymbol: '€', currencyCode: 'EUR' });
  assert.equal(await shopCurrencyCode(11), 'EUR');
  assert.deepEqual(addressQueries.at(-1), { userId: 11, addressType: 'LaundaryShopAddress' });

  // No zone yet / no shop / no owner: the platform fallback of resolveDisplayCurrency.
  assert.equal(await shopCurrencyCode(12), 'GBP', 'shop without a zone');
  assert.equal(await shopCurrencyCode(99), 'GBP', 'owner without a shop address');
  const queriesBefore = addressQueries.length;
  assert.equal(await shopCurrencyCode(null), 'GBP', 'no owner');
  assert.equal(addressQueries.length, queriesBefore, 'no owner: no address lookup');

  // A zone without a currency unit falls through, never to a hard-coded literal here.
  assert.equal(await zoneCurrencyCode(UNITLESS_ZONE), 'GBP');

  console.log('zoneCurrency.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
