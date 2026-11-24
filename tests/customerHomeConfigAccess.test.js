'use strict';

/**
 * GET /customer/getHomeConfig answers the zone's fees for the given coordinates. Nothing
 * in it belongs to an account, and a guest's Home shows the same fees, so a guest session
 * may read it: the route takes validateAccessTokenOrGuest (a registered customer's session
 * or a guest session; never no session). Before, it took validateAccessToken and guests
 * got 403 "Access Denied" and never saw the fees.
 *
 * Loads the real routes/customer.js with controllers and middlewares stubbed (no models,
 * Redis or config.json), then reads the Express route table.
 *   node tests/customerHomeConfigAccess.test.js
 */

const assert = require('assert');
const Module = require('module');

function validateAccessToken(req, res, next) { return next(); }
function validateAccessTokenOrGuest(req, res, next) { return next(); }
function validateGuestAccessToken(req, res, next) { return next(); }
const passThrough = (req, res, next) => next();
const controllerStub = new Proxy({}, { get: () => async () => {} });

const STUBS = {
    '../middlewares/accessToken': validateAccessToken,
    '../middlewares/accessTokenOrGuest': validateAccessTokenOrGuest,
    '../middlewares/guestAccessToken': validateGuestAccessToken,
    '../middlewares/asyncHandler': (fn) => fn,
    '../middlewares/otpRateLimit': {
        otpIssueIpLimit: passThrough,
        otpVerifyIpLimit: passThrough,
        passwordResetIpLimit: passThrough,
    },
    '../middlewares/promotionRateLimit': {
        promoCodeRateLimit: passThrough,
        promoEvaluateRateLimit: passThrough,
    },
    '../middlewares/postcodeRateLimit': {
        postcodeAutocompleteRateLimit: passThrough,
        postcodeValidateRateLimit: passThrough,
    },
    './driver': {},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    if (request.startsWith('../controllers/')) return controllerStub;
    return originalLoad.call(this, request, parent, isMain);
};
const customerRouter = require('../routes/customer');
Module._load = originalLoad;

function handlersOf(app, method, path) {
    const stack = (app._router || app.router).stack;
    for (const layer of stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method]) {
            return layer.route.stack.map((l) => l.handle);
        }
    }
    return null;
}

const homeConfig = handlersOf(customerRouter, 'get', '/getHomeConfig');
assert.ok(homeConfig, 'GET /getHomeConfig exists (installed app builds call it)');
assert.strictEqual(
    homeConfig[0],
    validateAccessTokenOrGuest,
    'GET /getHomeConfig checks a customer or guest session before anything else'
);
assert.ok(!homeConfig.includes(validateAccessToken), 'a guest session is not refused');

// The other zone readers a guest's booking flow uses take the same middleware.
for (const path of ['/fetchZoneAndCharges', '/bookingSlots']) {
    assert.strictEqual(handlersOf(customerRouter, 'get', path)[0], validateAccessTokenOrGuest, path);
}

// Account data stays behind a registered customer's session.
for (const path of ['/getUserProfile', '/customerAddresses', '/allBookings']) {
    assert.strictEqual(handlersOf(customerRouter, 'get', path)[0], validateAccessToken, path);
}

console.log('customerHomeConfigAccess.test.js: ok');
