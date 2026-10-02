'use strict';

const assert = require('assert/strict');
const {
    extractQueuedBookingId,
    shouldDropQueuedNewBooking,
    isQueuedEventExpired,
    MAX_QUEUE_AGE_MS,
} = require('../utils/unacknowledgedEventQueue');

assert.equal(extractQueuedBookingId({ bookingId: 1555 }), 1555);
assert.equal(extractQueuedBookingId({ id: 1567 }), 1567);
assert.equal(extractQueuedBookingId({ data: 1567 }), 1567);
assert.equal(extractQueuedBookingId({ data: { id: 1568 } }), 1568);
assert.equal(extractQueuedBookingId(1569), 1569);

assert.equal(shouldDropQueuedNewBooking(null), true);
assert.equal(
    shouldDropQueuedNewBooking({
        id: 1567,
        bookingStatusId: 1,
        laundryShopId: 423,
        createdAt: new Date(),
    }),
    true
);
assert.equal(
    shouldDropQueuedNewBooking({
        id: 1590,
        bookingStatusId: 1,
        laundryShopId: null,
        createdAt: new Date(),
    }),
    false
);
assert.equal(
    shouldDropQueuedNewBooking({
        id: 1,
        bookingStatusId: 3,
        laundryShopId: null,
        createdAt: new Date(),
    }),
    true
);

assert.equal(isQueuedEventExpired(new Date()), false);
assert.equal(
    isQueuedEventExpired(new Date(Date.now() - MAX_QUEUE_AGE_MS - 1000)),
    true
);

console.log('unacknowledgedEventQueue.test.js: ok');
