'use strict';

/**
 * resolveDisplayCurrency: currency from zone data only — no platform default, no
 * country map, no "first active zone" (models stubbed).
 *   node utils/resolveDisplayCurrency.test.js
 */

const assert = require('assert/strict');
const path = require('path');
const { Op } = require('sequelize');

const GBP = { id: 5, type: 'currency', name: 'GBP', symbol: '£' };
const USD = { id: 4, type: 'currency', name: 'USD', symbol: '$' };
const CHF_NO_SYMBOL = { id: 9, type: 'currency', name: 'chf', symbol: '' };
const NO_CODE = { id: 10, type: 'currency', name: '', symbol: '¤' };

// cityId → countryId
const CITIES = { 1: 44, 2: 44, 3: 1, 4: 99, 5: 77 };
// Zones: id, cityId, status, deleted, unit
const ZONES = [
  { id: 1, cityId: 1, status: true, unit: GBP },
  { id: 2, cityId: 2, status: true, unit: GBP },
  { id: 3, cityId: 2, status: false, unit: USD }, // inactive: ignored by aggregates
  { id: 4, cityId: 3, status: true, unit: USD },
  { id: 5, cityId: 3, status: true, unit: GBP }, // city 3 is mixed
  { id: 6, cityId: 4, status: true, unit: CHF_NO_SYMBOL },
  { id: 7, cityId: 5, status: true, unit: NO_CODE },
  { id: 8, cityId: 1, status: true, unit: USD, deleted: true }, // soft-deleted
];

function matches(z, where) {
  for (const [key, cond] of Object.entries(where)) {
    const value = z[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (cond[Op.in] && !cond[Op.in].includes(value)) return false;
      if (cond[Op.notIn] && cond[Op.notIn].includes(value)) return false;
    } else if (Array.isArray(cond)) {
      if (!cond.includes(value)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}
const row = (z) => ({ id: z.id, currencyUnitId: z.unit?.id ?? null, currencyUnitZ: z.unit || null });

const calls = [];
const UNIT_ROWS = [GBP, USD];
const models = {
  units: {
    findOne: async ({ where }) => UNIT_ROWS.find((u) => u.type === where.type && u.name === where.name) || null,
  },
  zone: {
    findByPk: async (id, opts) => {
      calls.push(['zone.findByPk', id, opts?.paranoid]);
      const z = ZONES.find((x) => x.id === id && (opts?.paranoid === false || !x.deleted));
      return z ? row(z) : null;
    },
    findAll: async ({ where }) => {
      calls.push(['zone.findAll', where]);
      return ZONES.filter((z) => !z.deleted && matches(z, where)).map(row);
    },
    findOne: async () => {
      throw new Error('resolveDisplayCurrency must not pick "the first zone"');
    },
  },
  cities: {
    findAll: async ({ where }) =>
      Object.entries(CITIES)
        .filter(([, countryId]) => countryId === where.countryId)
        .map(([id]) => ({ id: Number(id) })),
  },
  countries: {
    findByPk: async () => {
      throw new Error('a country never decides a currency');
    },
  },
};
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: models };

const mod = require('./resolveDisplayCurrency');
const { resolveDisplayCurrency, currencyOfZone, currencyOfCode, sharedCurrencyOfZones, fromUnit } = mod;

const NONE = { currencySymbol: '', currencyCode: '' };
const GBP_C = { currencySymbol: '£', currencyCode: 'GBP' };
const USD_C = { currencySymbol: '$', currencyCode: 'USD' };

(async () => {
  // The fallbacks are gone from the module surface.
  for (const gone of ['DEFAULT_CURRENCY', 'COUNTRY_ISO_TO_CURRENCY', 'resolveCurrencyUnitIdForCountry']) {
    assert.equal(mod[gone], undefined, `${gone} must not exist`);
  }

  // Zone filter → that zone's own unit (inactive and soft-deleted zones too).
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: 1 }), GBP_C);
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: '4' }), USD_C);
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: 3 }), USD_C, 'inactive zone keeps its currency');
  assert.deepEqual(await currencyOfZone(8), USD_C, 'soft-deleted zone: historic bookings keep their currency');
  assert.equal(calls.find((c) => c[0] === 'zone.findByPk')[2], false, 'zone lookups include soft-deleted');
  // The zone filter wins over a city / country filter.
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: 4, cityId: 1, countryId: 44 }), USD_C);
  // Unknown zone → empty, never another zone's currency.
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: 404 }), NONE);
  assert.deepEqual(await currencyOfZone(null), NONE);
  assert.deepEqual(await currencyOfZone('abc'), NONE);

  // City → the currency shared by all its active zones.
  assert.deepEqual(await resolveDisplayCurrency({ cityId: 2 }), GBP_C, 'inactive USD zone in city 2 is ignored');
  assert.deepEqual(await resolveDisplayCurrency({ cityId: 3 }), NONE, 'mixed city → unknown');
  assert.deepEqual(await resolveDisplayCurrency({ cityId: 999 }), NONE, 'city without zones → unknown');
  assert.deepEqual(await resolveDisplayCurrency({ cityId: 2, countryId: 1 }), GBP_C, 'city wins over country');

  // Country → the currency shared by all active zones in its cities.
  assert.deepEqual(await resolveDisplayCurrency({ countryId: 44 }), GBP_C);
  assert.deepEqual(await resolveDisplayCurrency({ countryId: 1 }), NONE, 'mixed country → unknown');
  assert.deepEqual(await resolveDisplayCurrency({ countryId: 12345 }), NONE, 'country without cities');

  // No filter → the currency shared by every active zone; here they differ → unknown.
  assert.deepEqual(await resolveDisplayCurrency({}), NONE);
  assert.deepEqual(await resolveDisplayCurrency(), NONE);
  assert.deepEqual(await sharedCurrencyOfZones({ status: true, cityId: { [Op.in]: [1, 2] } }), GBP_C);
  assert.deepEqual(await sharedCurrencyOfZones({ id: { [Op.in]: [] } }), NONE, 'no zones → unknown');

  // A unit with no symbol displays its ISO code; the code is upper-cased.
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: 6 }), { currencySymbol: 'CHF', currencyCode: 'CHF' });

  // A unit without an ISO code is a data error: unknown (and logged), never half a currency.
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.deepEqual(await resolveDisplayCurrency({ zoneId: 7 }), NONE);
    assert.deepEqual(await resolveDisplayCurrency({ cityId: 5 }), NONE);
    assert.equal(fromUnit({ id: 11, name: '  ', symbol: '' }), null);
  } finally {
    console.error = origError;
  }
  assert.ok(errors.length >= 1 && errors.every((e) => /no ISO code/.test(e)), 'missing ISO code is logged');
  assert.equal(fromUnit(null), null);

  // A stored ISO code → its unit's symbol; an unknown code displays as itself.
  assert.deepEqual(await currencyOfCode('gbp'), GBP_C);
  assert.deepEqual(await currencyOfCode('USD'), USD_C);
  assert.deepEqual(await currencyOfCode('NOK'), { currencySymbol: 'NOK', currencyCode: 'NOK' });
  assert.deepEqual(await currencyOfCode(''), NONE);
  assert.deepEqual(await currencyOfCode(null), NONE);

  // Results are copies: callers cannot mutate a shared EMPTY.
  const a = await resolveDisplayCurrency({ zoneId: 404 });
  a.currencyCode = 'XXX';
  assert.deepEqual(await resolveDisplayCurrency({ zoneId: 404 }), NONE);

  console.log('resolveDisplayCurrency.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
