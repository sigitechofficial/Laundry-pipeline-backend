'use strict';

/**
 * A new promotion that names no currency takes the one its zones share; when they do
 * not share one it is left unset so the admin is asked — never a platform default.
 * Run: node tests/promotionDefaultCurrency.test.js
 */

const assert = require('assert/strict');
const Module = require('module');
const { Op } = require('sequelize');

const GBP = { id: 5, name: 'GBP', symbol: '£' };
const USD = { id: 4, name: 'USD', symbol: '$' };
const ZONES = [
  { id: 1, status: true, unit: GBP },
  { id: 2, status: true, unit: GBP },
  { id: 3, status: true, unit: USD },
  { id: 4, status: false, unit: USD }, // inactive
];
const row = (z) => ({ id: z.id, currencyUnitId: z.unit.id, currencyUnitZ: z.unit });
let activeZones = ZONES;

const models = {
  sequelize: { query: async () => [], fn() {}, col() {}, literal() {} },
  Sequelize: {},
  units: {},
  cities: { findAll: async () => [] },
  zone: {
    findByPk: async (id) => {
      const z = ZONES.find((x) => x.id === Number(id));
      return z ? row(z) : null;
    },
    findAll: async ({ where }) => activeZones
      .filter((z) => (where.status === undefined || z.status === where.status))
      .filter((z) => !where.id || !where.id[Op.notIn].includes(z.id))
      .map(row),
    findOne: async () => {
      throw new Error('no "first zone" lookups');
    },
  },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../models' || request === '../../models' || request.endsWith('/models')) return models;
  return originalLoad.call(this, request, parent, isMain);
};

const { defaultPromotionCurrency } = require('../services/Admin/promotionAdminService');

(async () => {
  // Selected zones sharing one currency → that one.
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'selected', zoneIds: [1, 2] }), 'GBP');
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'selected', zoneIds: ['3'] }), 'USD');
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'selected', zoneIds: [4] }), 'USD', 'inactive zone still has its currency');
  // Selected zones in different currencies, unknown zones, or none → ask the admin.
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'selected', zoneIds: [1, 3] }), null);
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'selected', zoneIds: [1, 404] }), null);
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'selected', zoneIds: [] }), null);

  // All zones → the currency shared by every active zone (here GBP and USD → ask).
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'all' }), null);
  activeZones = ZONES.filter((z) => z.unit === GBP || !z.status);
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'all' }), 'GBP', 'inactive USD zone ignored');
  activeZones = [];
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'all' }), null, 'no zones at all');
  activeZones = ZONES;

  // Excluded zones → the currency shared by every other active zone.
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'excluded', zoneIds: [3] }), 'GBP');
  assert.equal(await defaultPromotionCurrency({ zoneScopeMode: 'excluded', zoneIds: [1] }), null);

  console.log('promotionDefaultCurrency.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  Module._load = originalLoad;
});
