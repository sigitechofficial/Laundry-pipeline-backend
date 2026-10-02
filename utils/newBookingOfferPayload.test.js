'use strict';

const assert = require('assert/strict');
const { buildNewBookingOfferPayload } = require('./newBookingOfferPayload');

const visibleAt = new Date();
const payload = buildNewBookingOfferPayload({
    bookingDetails: {
        id: 42,
        orderTrackId: '42-ABC',
        bookingStatusId: 1,
        createdAt: visibleAt,
        agentVisibleAt: visibleAt,
        orderExpireTime: '23:59:59',
        customer: { id: 7, firstName: 'Test' },
        pickupAddress: { id: 10 },
        dropOffAddress: { id: 11 },
    },
    collectionDate: '2026-10-02',
    collectionTimeFrom: '10:00:00',
    collectionTimeTo: '11:00:00',
    deliveryDate: '2026-10-03',
    deliveryTimeFrom: '10:00:00',
    deliveryTimeTo: '11:00:00',
    timeZone: 'Europe/London',
    offeredToShopId: 423,
    pickupDistanceKm: 1.25,
});

assert.equal(payload.id, 42);
assert.equal(payload.bookingStatusId, 1);
assert.equal(payload.laundryShopId, null);
assert.equal(payload.offeredToShopId, 423);
assert.equal(payload.pickupDistanceKm, 1.25);
assert.equal(payload.agentVisibleAt, visibleAt);
assert.equal(payload.customerId, 7);
assert.match(payload.collectionDate, /^2026-10-02T/);

console.log('newBookingOfferPayload tests passed');
