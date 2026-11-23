'use strict';

/**
 * Currency symbols come from the units table, never a hard-coded map (models stubbed).
 *   node utils/currencySymbols.test.js
 */

const assert = require('assert/strict');
const path = require('path');

let loads = 0;
const models = {
  units: {
    findAll: async ({ where }) => {
      loads++;
      assert.equal(where.type, 'currency');
      return [
        { id: 4, name: 'USD', symbol: '$' },
        { id: 5, name: 'gbp', symbol: '£' },
        { id: 9, name: 'CHF', symbol: '' },
        { id: 10, name: '', symbol: '¤' },
      ];
    },
  },
};
const modelsPath = require.resolve(path.join(__dirname, '..', 'models'));
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: models };

const { warmCurrencySymbols, currencySymbolOf } = require('./currencySymbols');

(async () => {
  // Before the units are loaded a code displays as itself — never a guessed symbol.
  assert.equal(currencySymbolOf('GBP'), 'GBP ');
  assert.equal(currencySymbolOf(''), '');
  assert.equal(currencySymbolOf(null), '');

  await Promise.all([warmCurrencySymbols(), warmCurrencySymbols()]);
  assert.equal(loads, 1, 'concurrent warm-ups share one load');
  await warmCurrencySymbols();
  assert.equal(loads, 1, 'cached');

  assert.equal(currencySymbolOf('GBP'), '£');
  assert.equal(currencySymbolOf('gbp'), '£');
  assert.equal(currencySymbolOf('USD'), '$');
  assert.equal(currencySymbolOf('CHF'), 'CHF ', 'unit without a symbol shows its code');
  assert.equal(currencySymbolOf('EUR'), 'EUR ', 'no unit for EUR here: its code, not a hard-coded €');

  console.log('currencySymbols.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
