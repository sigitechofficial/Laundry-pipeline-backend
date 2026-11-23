'use strict';

const assert = require('assert');
const { parseTimeRequiredHours, parseTimeRequiredDays } = require('./turnaroundTime');

assert.strictEqual(parseTimeRequiredHours('12-24 hours'), 24);
assert.strictEqual(parseTimeRequiredHours('48-72 hours'), 72);
assert.strictEqual(parseTimeRequiredHours('2 days'), 48);
assert.strictEqual(parseTimeRequiredHours(''), null);
assert.strictEqual(parseTimeRequiredHours('ask the shop'), null);
assert.strictEqual(parseTimeRequiredDays('24-48 hours'), 2); // never 2448
console.log('turnaroundTime.test.js: all assertions passed');
