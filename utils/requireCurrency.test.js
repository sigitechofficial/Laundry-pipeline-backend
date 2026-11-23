'use strict';

/** Currency guards for pure money helpers.   node utils/requireCurrency.test.js */

const assert = require('assert/strict');
const { requireCurrencyCode, requireCurrencySymbol } = require('./requireCurrency');

assert.equal(requireCurrencyCode('GBP', 't'), 'GBP');
assert.equal(requireCurrencyCode(' gbp ', 't'), 'GBP', 'trimmed, upper-cased ISO code');
assert.equal(requireCurrencySymbol(' £ ', 't'), '£', 'trimmed symbol');
assert.equal(requireCurrencySymbol('د.إ', 't'), 'د.إ');

for (const missing of [undefined, null, '', '   ']) {
  assert.throws(() => requireCurrencyCode(missing, 'someHelper'), {
    name: 'TypeError',
    message: /^someHelper: currency code is required/,
  });
  assert.throws(() => requireCurrencySymbol(missing, 'someHelper'), {
    name: 'TypeError',
    message: /^someHelper: currency symbol is required/,
  });
}

console.log('requireCurrency.test.js passed');
