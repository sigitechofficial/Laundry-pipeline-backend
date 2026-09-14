'use strict';

const assert = require('assert');
const {
  isValidCustomerPhone,
  customerPhoneError,
  compactPhone,
} = require('./customerPhone');

assert.strictEqual(isValidCustomerPhone('07911123456'), true);
assert.strictEqual(isValidCustomerPhone('07911 123456'), true);
assert.strictEqual(isValidCustomerPhone('+44 7911 123456'), true);
assert.strictEqual(isValidCustomerPhone('+447911123456'), true);
assert.strictEqual(isValidCustomerPhone('7911123456'), true);
assert.strictEqual(isValidCustomerPhone('447911123456'), true);

assert.strictEqual(isValidCustomerPhone(''), false);
assert.strictEqual(isValidCustomerPhone('123'), false);
assert.strictEqual(isValidCustomerPhone('abc07911123456'), false);
assert.strictEqual(isValidCustomerPhone('++44'), false);

assert.ok(customerPhoneError('').includes('required'));
assert.ok(customerPhoneError('12').includes('UK phone'));
assert.strictEqual(customerPhoneError('07911123456'), null);
assert.strictEqual(compactPhone('+44 7911 123456'), '+447911123456');

console.log('customerPhone tests passed');
