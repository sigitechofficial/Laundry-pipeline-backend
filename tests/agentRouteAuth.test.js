'use strict';

/**
 * Every /agent route requires a signed-in session (validateAccessToken) unless it is
 * listed below as public, with the reason. A new route without the middleware, or a
 * route that loses it, fails this test.
 *
 * Loads the real routes/agent.js with controllers and middlewares stubbed (no models,
 * Redis or config.json), then reads the Express route table.
 *   node tests/agentRouteAuth.test.js
 */

const assert = require('assert');
const Module = require('module');

function validateAccessToken(req, res, next) { return next(); }
function accessTokenIfPresent(req, res, next) { return next(); }
function requireShopOwner(req, res, next) { return next(); }
const passThrough = (req, res, next) => next();

/** Any controller: every exported handler is a no-op function. */
const controllerStub = new Proxy({}, { get: () => async () => {} });

const STUBS = {
  '../middlewares/accessToken': validateAccessToken,
  '../middlewares/accessTokenIfPresent': accessTokenIfPresent,
  '../middlewares/checkPermission': passThrough,
  '../middlewares/requireShopOwner': {
    requireShopOwner,
    requireShopManagerOrOwner: passThrough,
    requireCapability: () => passThrough,
    requireAnyCapability: () => passThrough,
    requireBookingAssignee: () => passThrough,
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

const agentRouter = require('../routes/agent');
Module._load = originalLoad;

/**
 * Routes that are reachable without a session, and why. Keep this list short:
 * anything that reads or writes one shop's or one customer's data belongs behind
 * validateAccessToken and reads the caller's shop (shopAgentIdFromReq).
 */
const PUBLIC_ROUTES = {
  // Sign-up, sign-in and password reset: the caller has no session yet.
  'POST /registerAgent': 'sign-up',
  'POST /verifyOTpSignUp': 'sign-up OTP',
  'POST /resendotp': 'sign-up OTP',
  'POST /loginUser': 'sign-in',
  'POST /employeeLogin': 'staff sign-in',
  'POST /forgetPasswordRequest': 'password reset',
  'POST /verifyOTPforPassword': 'password reset',
  'POST /changePasswordOTP': 'password reset',
  // Platform reference catalogs (no shop or customer data), used before sign-in.
  'GET /getAllServices': 'platform service catalog (registration form, splash)',
  'GET /getCountries': 'country list (registration form)',
  'GET /getCities': 'city list (registration form)',
  'GET /getOnHoldOptions': 'platform on-hold reason list',
  // PENDING DECISION — registration-time writes that installed app builds call
  // without a session (and, for the login "business info missing" path, the backend
  // issues none). They trust a client-sent shop id and must move behind a session
  // with the app; tracked separately, not silently changed here.
  'POST /addBusinessInfor': 'PENDING: registration write, trusts body userId',
  'POST /agentAddressAdd': 'PENDING: registration write, trusts body userId',
  'POST /businesInfoAdded/:userId': 'PENDING: registration write, trusts :userId',
  'PATCH /workingHoursUpdate/:userId': 'PENDING: registration + profile write, trusts :userId',
  // PENDING DECISION — registration-time reads (same onboarding-session work). They
  // run accessTokenIfPresent: a signed-in caller reads only its own shop; a request
  // without a session still reads the shop named by :userId, as installed builds
  // need during registration.
  'GET /getBussinessInforMation/:userId': 'PENDING: registration read, session optional',
  'GET /getBussinessWrkinghours/:userId': 'PENDING: registration read, session optional',
};

/** Public routes that still honour a session when one is sent (checked first). */
const OPTIONAL_SESSION_ROUTES = [
  'GET /getBussinessInforMation/:userId',
  'GET /getBussinessWrkinghours/:userId',
];

function routeTable(app) {
  const stack = (app._router || app.router).stack;
  const out = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const handles = layer.route.stack.map((l) => l.handle);
    for (const method of Object.keys(layer.route.methods)) {
      out.push({
        key: `${method.toUpperCase()} ${layer.route.path}`,
        authenticated: handles.includes(validateAccessToken),
        authFirst: handles[0] === validateAccessToken,
        optionalSessionFirst: handles[0] === accessTokenIfPresent,
        ownerOnly: handles.includes(requireShopOwner),
      });
    }
  }
  return out;
}

const routes = routeTable(agentRouter);
const byKey = new Map(routes.map((r) => [r.key, r]));
assert.ok(routes.length > 100, `route table loaded (${routes.length} routes)`);

// Shop routes that used to be open: session required, checked before anything else.
for (const key of [
  'GET /platformOperationalHours',
  'GET /generateStripeOnboardingLink',
  'GET /getPermissions',
]) {
  const route = byKey.get(key);
  assert.ok(route, `${key} exists (installed app builds call it)`);
  assert.ok(route.authenticated && route.authFirst, `${key} requires a session first`);
}

// Registration-time reads: a session, when sent, is verified before anything else.
for (const key of OPTIONAL_SESSION_ROUTES) {
  const route = byKey.get(key);
  assert.ok(route, `${key} exists (installed app builds call it)`);
  assert.ok(!route.authenticated && route.optionalSessionFirst, `${key}: accessTokenIfPresent runs first`);
}
assert.deepStrictEqual(
  routes.filter((r) => r.optionalSessionFirst).map((r) => r.key).sort(),
  [...OPTIONAL_SESSION_ROUTES].sort(),
  'only the documented registration reads use accessTokenIfPresent'
);

// Stripe Connect onboarding is the owner's payout account: owner only.
assert.ok(byKey.get('GET /generateStripeOnboardingLink').ownerOnly, 'Stripe onboarding link: owner only');

const unauthenticated = routes.filter((r) => !r.authenticated).map((r) => r.key).sort();
const expectedPublic = Object.keys(PUBLIC_ROUTES).sort();
assert.deepStrictEqual(
  unauthenticated,
  expectedPublic,
  'only the documented public routes may skip validateAccessToken'
);
for (const r of routes.filter((x) => x.authenticated)) {
  assert.ok(r.authFirst, `${r.key}: validateAccessToken runs before other middleware`);
}

console.log(`agentRouteAuth tests passed (${routes.length} routes, ${unauthenticated.length} public)`);
