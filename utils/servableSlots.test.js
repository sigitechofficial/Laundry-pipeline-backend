'use strict';

const assert = require('assert');
const { slotFitsAnyWindow } = require('./servableSlots');

const shop = [{ openTime: '09:00:00', closeTime: '18:00:00' }];

// The slot must lie wholly inside a shop's working hours that day.
assert.strictEqual(slotFitsAnyWindow('09:00', '10:00', shop), true);
assert.strictEqual(slotFitsAnyWindow('17:00', '18:00', shop), true);
assert.strictEqual(slotFitsAnyWindow('07:00', '08:00', shop), false); // booking 182's case
assert.strictEqual(slotFitsAnyWindow('17:30', '18:30', shop), false); // runs past closing
assert.strictEqual(slotFitsAnyWindow('09:00', '10:00', []), false); // no shop works that day

// Any one shop is enough.
const two = [...shop, { openTime: '07:00', closeTime: '12:00' }];
assert.strictEqual(slotFitsAnyWindow('07:00', '08:00', two), true);

// Malformed input never counts as servable.
assert.strictEqual(slotFitsAnyWindow('10:00', '09:00', shop), false);
assert.strictEqual(slotFitsAnyWindow(null, '10:00', shop), false);
assert.strictEqual(slotFitsAnyWindow('09:00', '10:00', [{ openTime: '18:00', closeTime: '09:00' }]), false);

console.log('servableSlots.test.js: all assertions passed');
