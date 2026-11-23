'use strict';

/**
 * A zone must always have a currency: required on create, never cleared on edit, and
 * it must be a real currency unit with an ISO code (models stubbed).
 *   node tests/zoneValidation.test.js
 */

const assert = require('assert/strict');
const path = require('path');

const UNITS = {
  3: { id: 3, type: 'distance', name: 'kilometer' },
  4: { id: 4, type: 'currency', name: 'USD' },
  5: { id: 5, type: 'currency', name: 'GBP' },
  6: { id: 6, type: 'currency', name: '' },
  7: { id: 7, type: null, name: 'EUR' },
  8: { id: 8, type: 'currency', name: 'JPY', deleted: true },
};
const models = {
  units: { findByPk: async (id) => UNITS[id] || null },
  cities: { findByPk: async (id) => (id === 1 ? { id: 1 } : null) },
  users: { findByPk: async (id) => (id === 2 ? { id: 2 } : null) },
};
const root = path.join(__dirname, '..');
const modelsPath = require.resolve(path.join(root, 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: models };

const { validateZoneData } = require(path.join(root, 'services', 'Admin', 'zoneValidation'));

async function rejects(data, opts, pattern, name) {
  await assert.rejects(() => validateZoneData(data, opts), (err) => {
    assert.match(err.message, pattern, name);
    assert.ok(['ValidationError', 'NotFoundError'].includes(err.name), `${name}: ${err.name}`);
    return true;
  }, name);
}

const CREATE = { creating: true };
const UPDATE = { creating: false };

(async () => {
  // Create: the currency is required.
  await rejects({ name: 'Z', cityId: 1 }, CREATE, /zone currency/, 'create without currency');
  await rejects({ currencyUnitId: '' }, CREATE, /zone currency/, 'create with empty currency');
  await rejects({ currencyUnitId: null }, CREATE, /zone currency/, 'create with null currency');
  await rejects({ currencyUnitId: 'abc' }, CREATE, /currency unit id/, 'non-numeric id');
  await rejects({ currencyUnitId: 0 }, CREATE, /currency unit id/, 'zero id');
  await rejects({ currencyUnitId: 404 }, CREATE, /not found/, 'unknown unit');
  await rejects({ currencyUnitId: 3 }, CREATE, /must reference a currency unit/, 'distance unit');
  await rejects({ currencyUnitId: 7 }, CREATE, /must reference a currency unit/, 'unit without a type');
  await rejects({ currencyUnitId: 6 }, CREATE, /no ISO code/, 'unit without an ISO code');
  await rejects({ currencyUnitId: 8 }, CREATE, /not found/, 'deleted unit');

  const created = { name: 'Z', cityId: 1, currencyUnitId: '5', zoneAdminId: 2 };
  await validateZoneData(created, CREATE);
  assert.equal(created.currencyUnitId, 5, 'normalised to the unit id');

  // Update: omitted = unchanged; present = must be valid; cannot be cleared.
  await validateZoneData({ serviceCharge: 2 }, UPDATE);
  await rejects({ currencyUnitId: '' }, UPDATE, /zone currency/, 'update clearing currency');
  await rejects({ currencyUnitId: null }, UPDATE, /zone currency/, 'update nulling currency');
  await rejects({ currencyUnitId: 3 }, UPDATE, /must reference a currency unit/, 'update to a distance unit');
  const updated = { currencyUnitId: 4 };
  await validateZoneData(updated, UPDATE);
  assert.equal(updated.currencyUnitId, 4);

  // The other references are still checked.
  await rejects({ currencyUnitId: 5, cityId: 9 }, CREATE, /City not found/, 'unknown city');
  await rejects({ currencyUnitId: 5, zoneAdminId: 9 }, CREATE, /Zone admin user not found/, 'unknown admin');
  await rejects({ currencyUnitId: 5, distanceUnitId: 99 }, CREATE, /Distance unit not found/, 'unknown distance unit');

  console.log('zoneValidation.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
