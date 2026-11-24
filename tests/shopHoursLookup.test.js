'use strict';

/**
 * The New list checks every candidate booking's pickup against the shop's working hours.
 * workingHoursByDayLookup reads the shop's hours row once per weekday, and
 * isPickupWithinShopWorkingHours gives the same answer with or without it.
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const hoursQueries = [];
const hours = {
    Monday: { openTime: '08:00:00', closeTime: '18:00:00', status: true, dayOfWeek: 'Monday' },
    Tuesday: { openTime: '08:00:00', closeTime: '12:00:00', status: true, dayOfWeek: 'Tuesday' },
    Wednesday: { openTime: '08:00:00', closeTime: '18:00:00', status: false, dayOfWeek: 'Wednesday' },
};
const fakeModels = new Proxy(
    {
        bussinessWorkingHours: {
            findOne: async ({ where }) => {
                hoursQueries.push(where.dayOfWeek);
                return hours[where.dayOfWeek] || null;
            },
        },
        // No hours row by userId → the fallback looks for the shop address: none here.
        addressDb: { findOne: async () => null },
    },
    { get: (t, p) => (p in t ? t[p] : {}) }
);
const modelsPath = path.resolve(__dirname, '../models');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && parent.filename && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        if (resolved === modelsPath) return fakeModels;
    }
    return originalLoad.apply(this, arguments);
};

const {
    isPickupWithinShopWorkingHours,
    workingHoursByDayLookup,
} = require('../utils/shopWorkingHours');

(async () => {
    const tz = 'Europe/London';
    // 2026-11-23 Monday, 2026-11-24 Tuesday, 2026-11-25 Wednesday, 2026-11-26 Thursday.
    const candidates = [
        ['2026-11-23', '09:00:00', '10:00:00'],
        ['2026-11-23', '17:30:00', '18:30:00'],
        ['2026-11-24', '09:00:00', '10:00:00'],
        ['2026-11-24', '13:00:00', '14:00:00'],
        ['2026-11-23', '10:00:00', '11:00:00'],
        ['2026-11-25', '09:00:00', '10:00:00'],
        ['2026-11-26', '09:00:00', '10:00:00'],
    ];

    const expected = [];
    for (const [date, from, to] of candidates) {
        expected.push(await isPickupWithinShopWorkingHours(2, new Date(`${date}T12:00:00Z`), from, to, tz));
    }
    assert.strictEqual(hoursQueries.filter((d) => d !== 'Thursday').length, 6);

    hoursQueries.length = 0;
    const lookup = workingHoursByDayLookup(2);
    const actual = [];
    for (const [date, from, to] of candidates) {
        actual.push(await isPickupWithinShopWorkingHours(2, new Date(`${date}T12:00:00Z`), from, to, tz, lookup));
    }
    assert.deepStrictEqual(actual, expected, 'same answers with the lookup');
    assert.deepStrictEqual(actual, [true, false, true, false, true, false, false]);
    assert.deepStrictEqual(hoursQueries, ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], 'one read per weekday');

    console.log('shopHoursLookup tests passed');
    process.exit(0); // the Redis client required by agentOnlineStatus keeps the loop alive
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
