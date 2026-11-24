'use strict';

const assert = require('assert');
const { timeOfDaySeconds, bookingFitsAgentSlot } = require('./agentSlotWindow');

const rules = (withDay) => ({
    withDay,
    pickupStatuses: [3, 4, 5, 6, 7],
    postPickupStatuses: [8, 9, 10, 11, 18, 22, 12, 13, 14, 15, 16],
});

assert.strictEqual(timeOfDaySeconds('07:00'), 7 * 3600);
assert.strictEqual(timeOfDaySeconds('07:00:00'), 7 * 3600);
assert.strictEqual(timeOfDaySeconds('18:30:15'), 18 * 3600 + 30 * 60 + 15);
assert.strictEqual(timeOfDaySeconds(null), null);
assert.strictEqual(timeOfDaySeconds(''), null);

// MySQL TIME semantics, not string order: '08:00:00' <= '08:00' holds.
const pickup = { bookingStatusId: 3, collectionTimeFrom: '07:00:00', collectionTimeTo: '08:00:00' };
assert.strictEqual(bookingFitsAgentSlot(pickup, '07:00', '08:00', rules(true)), true);
assert.strictEqual(bookingFitsAgentSlot(pickup, '08:00', '09:00', rules(true)), false);
// A 30-minute window inside the slot.
assert.strictEqual(
    bookingFitsAgentSlot({ bookingStatusId: 5, collectionTimeFrom: '09:15:00', collectionTimeTo: '09:45:00' }, '09:00', '10:00', rules(false)),
    true
);
// Spanning two slots fits neither (from >= slotFrom AND to <= slotTo).
const spanning = { bookingStatusId: 4, collectionTimeFrom: '09:30:00', collectionTimeTo: '10:30:00' };
assert.strictEqual(bookingFitsAgentSlot(spanning, '09:00', '10:00', rules(true)), false);
assert.strictEqual(bookingFitsAgentSlot(spanning, '10:00', '11:00', rules(true)), false);
// The slot query's column alias "collectiontimeTo" is read too.
assert.strictEqual(
    bookingFitsAgentSlot({ bookingStatusId: 3, collectionTimeFrom: '07:00:00', collectiontimeTo: '07:30:00' }, '07:00', '08:00', rules(false)),
    true
);
// NULL never fits.
assert.strictEqual(bookingFitsAgentSlot({ bookingStatusId: 3, collectionTimeFrom: null, collectionTimeTo: '08:00:00' }, '07:00', '08:00', rules(true)), false);
// Facility+ phase uses the delivery window, and only when a day is given.
const atShop = { bookingStatusId: 12, collectionTimeFrom: '07:00:00', collectionTimeTo: '08:00:00', deliveryTimeFrom: '14:00:00', deliveryTimeTo: '15:00:00' };
assert.strictEqual(bookingFitsAgentSlot(atShop, '14:00', '15:00', rules(true)), true);
assert.strictEqual(bookingFitsAgentSlot(atShop, '07:00', '08:00', rules(true)), false);
assert.strictEqual(bookingFitsAgentSlot(atShop, '14:00', '15:00', rules(false)), false);
// Statuses outside both phases never fit.
assert.strictEqual(bookingFitsAgentSlot({ ...pickup, bookingStatusId: 1 }, '07:00', '08:00', rules(true)), false);
// The 12:00 slot ends at "01:00" (getNextHourTime), as in SQL: nothing after noon fits it.
assert.strictEqual(
    bookingFitsAgentSlot({ bookingStatusId: 3, collectionTimeFrom: '12:00:00', collectionTimeTo: '13:00:00' }, '12:00', '01:00', rules(true)),
    false
);

console.log('agentSlotWindow tests passed');
