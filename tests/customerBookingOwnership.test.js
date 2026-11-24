'use strict';

/**
 * Customer routes that name a booking answer only for the signed-in customer's own booking:
 * middlewares/requireOwnBooking checks it before the handler, and another customer's booking
 * gets the same 404 as one that does not exist. (GET /customer/bookingDetailsById and
 * /trackOrder used to return any customer's order, with their email and addresses.)
 *
 * 1. The middleware against a stubbed booking table: owner passes, anyone else gets 404.
 * 2. The real routes/customer.js (controllers stubbed): every booking route runs it right
 *    after the session check.
 *   node tests/customerBookingOwnership.test.js
 */

const assert = require('assert');
const Module = require('module');
const { requireOwnBooking } = require('../middlewares/requireOwnBooking');

const BOOKINGS = [
    { id: 41, customerId: 7, orderTrackId: '41-111111' },
    { id: 42, customerId: 8, orderTrackId: '42-222222' },
];
const bookingModel = {
    findOne: async ({ where }) =>
        BOOKINGS.find((b) =>
            Object.entries(where).every(([k, v]) => b[k] === v)
        ) || null,
};

async function run(customerId, { params = {}, query = {}, body = {} } = {}) {
    const req = { user: { id: customerId }, params, query, body };
    let error = null;
    await requireOwnBooking({ bookingModel })(req, {}, (err) => { error = err || null; });
    return { error, req };
}

(async () => {
    // Owner: passes, by id (path, query or body) or by order track id.
    for (const where of [{ params: { bookingId: '41' } }, { query: { bookingId: '41' } }, { body: { bookingId: 41 } },
        { query: { orderTrackId: '41-111111' } }, { query: { bookingId: '41', orderTrackId: '41-111111' } }]) {
        const { error, req } = await run(7, where);
        assert.strictEqual(error, null, `owner passes: ${JSON.stringify(where)}`);
        assert.strictEqual(req.ownBookingId, 41);
    }

    // Another customer's booking, a missing one, a mismatched pair, junk: the same 404.
    for (const [customerId, where] of [
        [8, { query: { bookingId: '41' } }],
        [8, { query: { orderTrackId: '41-111111' } }],
        [7, { query: { bookingId: '42' } }],
        [7, { query: { bookingId: '999' } }],
        [7, { query: { bookingId: '41', orderTrackId: '42-222222' } }],
        [7, { query: { bookingId: '41 OR 1=1' } }],
        [undefined, { query: { bookingId: '41' } }],
    ]) {
        const { error } = await run(customerId, where);
        assert.ok(error, `refused: customer ${customerId} ${JSON.stringify(where)}`);
        assert.strictEqual(error.statusCode, 404);
        assert.strictEqual(error.message, 'Booking not found');
    }

    // No booking named: 400 (the old handler then read the first booking of the table).
    const { error: missing } = await run(7, {});
    assert.strictEqual(missing.statusCode, 400);

    // Route table.
    function validateAccessToken(req, res, next) { return next(); }
    function ownBooking(req, res, next) { return next(); }
    const passThrough = (req, res, next) => next();
    const STUBS = {
        '../middlewares/accessToken': validateAccessToken,
        '../middlewares/accessTokenOrGuest': passThrough,
        '../middlewares/guestAccessToken': passThrough,
        '../middlewares/requireOwnBooking': { requireOwnBooking: () => ownBooking },
        '../middlewares/asyncHandler': (fn) => fn,
        '../middlewares/otpRateLimit': { otpIssueIpLimit: passThrough, otpVerifyIpLimit: passThrough, passwordResetIpLimit: passThrough },
        '../middlewares/promotionRateLimit': { promoCodeRateLimit: passThrough, promoEvaluateRateLimit: passThrough },
        '../middlewares/postcodeRateLimit': { postcodeAutocompleteRateLimit: passThrough, postcodeValidateRateLimit: passThrough },
        './driver': {},
    };
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
        if (request.startsWith('../controllers/')) return new Proxy({}, { get: () => async () => {} });
        return originalLoad.call(this, request, parent, isMain);
    };
    const router = require('../routes/customer');
    Module._load = originalLoad;

    const handlers = (method, path) => {
        for (const layer of (router._router || router.router).stack) {
            if (layer.route && layer.route.path === path && layer.route.methods[method]) {
                return layer.route.stack.map((l) => l.handle);
            }
        }
        return null;
    };
    for (const [method, path] of [
        ['get', '/bookingDetailsById'],
        ['get', '/trackOrder'],
        ['get', '/live-tracking/:bookingId'],
        ['patch', '/customerResponseUpdate'],
        ['get', '/onHoldCustomerShow'],
        ['get', '/bookings/:bookingId/reviewEligibility'],
        ['get', '/bookings/:bookingId/extra-tip'],
        ['post', '/bookings/:bookingId/extra-tip'],
        ['get', '/updateBookingUpfrontAmount'],
        ['get', '/getOnHoldBookings/:bookingId'],
        ['patch', '/updateCustomerResponseForOnHoldBooking'],
        ['post', '/cancelBooking'],
        ['post', '/rescheduleBooking'],
    ]) {
        const h = handlers(method, path);
        assert.ok(h, `${method.toUpperCase()} ${path} exists`);
        assert.strictEqual(h[0], validateAccessToken, `${path}: session first`);
        assert.strictEqual(h[1], ownBooking, `${path}: ownership checked before the handler`);
    }

    console.log('customerBookingOwnership.test.js: ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
