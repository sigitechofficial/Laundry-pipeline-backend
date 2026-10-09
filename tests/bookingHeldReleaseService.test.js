'use strict';

const assert = require('assert/strict');
const Module = require('module');

const rows = [];
const broadcasts = [];
let notifyCount = 1;
let throwOnBroadcast = false;

function modelRow(state) {
    return {
        ...state,
        get() {
            return { ...this };
        },
    };
}

function matchesUpdate(row, where) {
    if (Number(row.id) !== Number(where.id)) return false;
    if (
        Object.prototype.hasOwnProperty.call(where, 'agentBroadcastHeld') &&
        row.agentBroadcastHeld !== where.agentBroadcastHeld
    ) {
        return false;
    }
    if (
        Object.prototype.hasOwnProperty.call(where, 'preferredShopBroadcastDone') &&
        row.preferredShopBroadcastDone !== where.preferredShopBroadcastDone
    ) {
        return false;
    }
    if (
        Object.prototype.hasOwnProperty.call(where, 'bookingStatusId') &&
        row.bookingStatusId !== where.bookingStatusId
    ) {
        return false;
    }
    if (
        Object.prototype.hasOwnProperty.call(where, 'laundryShopId') &&
        row.laundryShopId !== where.laundryShopId
    ) {
        return false;
    }
    return true;
}

const booking = {
    async findAll({ where }) {
        if (where.agentBroadcastHeld === true) {
            return rows.filter(
                (row) =>
                    row.agentBroadcastHeld === true &&
                    row.bookingStatusId === 1 &&
                    row.laundryShopId == null &&
                    (where.zoneId == null || row.zoneId === where.zoneId)
            );
        }
        if (where.preferredShopBroadcastDone === false) {
            return rows.filter(
                (row) =>
                    row.agentBroadcastHeld === false &&
                    row.preferredShopBroadcastDone === false &&
                    row.bookingStatusId === 1 &&
                    row.laundryShopId == null &&
                    (where.zoneId == null || row.zoneId === where.zoneId)
            );
        }
        return [];
    },
    async findByPk(id) {
        return rows.find((row) => Number(row.id) === Number(id)) || null;
    },
    async update(values, { where }) {
        const row = rows.find((candidate) => matchesUpdate(candidate, where));
        if (!row) return [0];
        Object.assign(row, values);
        return [1];
    },
};

const adminAlerts = [];
const stubs = {
    '../models': {
        booking,
        customerSelectedService: {
            async findAll({ where }) {
                return [{ bookingId: where.bookingId, serviceId: 9 }];
            },
        },
    },
    '../utils/shopWorkingHours': {
        async isAnyShopOpenInZone() {
            return true;
        },
    },
    '../utils/bookingTimeZone': {
        getOrderExpireTime() {
            return '12:30:00';
        },
    },
    '../utils/countryTimeZone': {
        async getCountryContextFromZoneId() {
            return { ianaTimeZone: 'Europe/London' };
        },
    },
    './Customer/customerOrderService': {
        async bookingEventSentCheckTheShops(bookingId) {
            broadcasts.push(bookingId);
            if (throwOnBroadcast) throw new Error('simulated delivery failure');
            return { notifiedCount: notifyCount };
        },
        // Held release now routes like a new booking (preferred shop first);
        // with no preferred shop that is the same broadcast.
        async routePendingBooking(bookingId) {
            broadcasts.push(bookingId);
            if (throwOnBroadcast) throw new Error('simulated delivery failure');
            return { mode: 'broadcast', notifiedCount: notifyCount };
        },
        async alertAdminNoShopOnce(bookingId) {
            adminAlerts.push(bookingId);
            return true;
        },
    },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    prepareNewBookingVisibilityForZone,
    broadcastExpiredPreferredBookings,
} = require('../services/bookingHeldReleaseService');

function baseRow(id, overrides = {}) {
    return modelRow({
        id,
        zoneId: 25,
        bookingStatusId: 1,
        laundryShopId: null,
        agentBroadcastHeld: true,
        preferredShopBroadcastDone: true,
        preferredShopAgentId: null,
        collectionDate: new Date('2026-10-02'),
        collectionTimeFrom: '10:00:00',
        collectionTimeTo: '11:00:00',
        deliveryDate: new Date('2026-10-03'),
        deliveryTimeFrom: '10:00:00',
        deliveryTimeTo: '11:00:00',
        placedOutsidePlatformHours: false,
        ...overrides,
    });
}

async function run() {
    rows.push(baseRow(101), baseRow(102), baseRow(103));

    const [first, overlapping] = await Promise.all([
        prepareNewBookingVisibilityForZone(25),
        prepareNewBookingVisibilityForZone(25),
    ]);

    assert.equal(first.released + overlapping.released, 3);
    assert.deepEqual(broadcasts.sort(), [101, 102, 103]);
    assert.ok(rows.slice(0, 3).every((row) => row.agentBroadcastHeld === false));
    assert.ok(rows.slice(0, 3).every((row) => row.agentVisibleAt instanceof Date));
    assert.ok(rows.slice(0, 3).every((row) => row.orderExpireTime === '12:30:00'));

    rows.length = 0;
    broadcasts.length = 0;
    rows.push(
        baseRow(201, {
            agentBroadcastHeld: false,
            preferredShopBroadcastDone: false,
            preferredShopAgentId: 55,
            preferredShopExpiresAt: new Date(Date.now() - 1000),
        })
    );

    notifyCount = 1;
    const successful = await broadcastExpiredPreferredBookings({ zoneId: 25 });
    assert.equal(successful.broadcast, 1);
    assert.equal(rows[0].preferredShopBroadcastDone, true);
    assert.ok(rows[0].agentVisibleAt instanceof Date);
    assert.equal(rows[0].orderExpireTime, '12:30:00');

    rows[0].preferredShopBroadcastDone = false;
    rows[0].preferredShopExpiresAt = new Date(Date.now() - 1000);
    notifyCount = 0;
    const retryable = await broadcastExpiredPreferredBookings({ zoneId: 25 });
    assert.equal(retryable.broadcast, 0);
    assert.equal(rows[0].preferredShopBroadcastDone, false);
    assert.ok(rows[0].preferredShopExpiresAt.getTime() > Date.now());

    rows.length = 0;
    broadcasts.length = 0;
    rows.push(baseRow(301));
    throwOnBroadcast = true;
    const failedDelivery = await prepareNewBookingVisibilityForZone(25);
    throwOnBroadcast = false;
    assert.equal(failedDelivery.released, 0);
    assert.equal(rows[0].agentBroadcastHeld, true);
    assert.equal(rows[0].agentVisibleAt, null);
    assert.equal(rows[0].orderExpireTime, null);

    console.log('bookingHeldReleaseService tests passed');
}

run()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        Module._load = originalLoad;
    });
