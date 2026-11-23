'use strict';

const assert = require('assert/strict');
const { paymentWindowEndsAt, remainingMinutes } = require('./invoicePaymentWindow');

const pickup = '2026-11-23T12:59:01.000Z';
assert.equal(paymentWindowEndsAt(pickup, 60).toISOString(), '2026-11-23T13:59:01.000Z');
assert.equal(paymentWindowEndsAt(new Date(pickup), 90).toISOString(), '2026-11-23T14:29:01.000Z');
assert.equal(paymentWindowEndsAt(null, 60), null, 'no pickup yet: no deadline');
assert.equal(paymentWindowEndsAt('not a date', 60), null);
assert.equal(paymentWindowEndsAt(pickup, 0), null);
assert.equal(paymentWindowEndsAt(pickup, null), null);

const ends = new Date('2026-11-23T13:59:01.000Z');
assert.equal(remainingMinutes(ends, Date.parse('2026-11-23T13:00:00.000Z')), 60, 'rounds up partial minutes');
assert.equal(remainingMinutes(ends, Date.parse('2026-11-23T13:59:00.500Z')), 1);
assert.equal(remainingMinutes(ends, Date.parse('2026-11-23T14:30:00.000Z')), 0, 'never negative');
assert.equal(remainingMinutes(null), null);

console.log('invoicePaymentWindow.test.js: all assertions passed');
