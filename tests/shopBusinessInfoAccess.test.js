'use strict';

/**
 * Shop business information / working hours are read for the right shop only:
 *   - agent app: always the signed-in caller's own shop (an employee → the shop it
 *     works for); the legacy `:userId` path param never selects the shop.
 *   - admin portal: any shop owner, zone staff only inside their zone.
 * Pure: models are in-memory, so it runs in CI without config.json.
 *   node tests/shopBusinessInfoAccess.test.js
 */

const assert = require('assert');
const Module = require('module');

// ─── In-memory data ──────────────────────────────────────────────────────────
// Owner 2 runs a shop in zone 10 (UK); user 16 is its Laundry Shop Manager and has
// no shop address of its own. Owner 3 runs another shop in zone 20 (Pakistan).
const COUNTRIES = {
  1: { id: 1, name: 'United Kingdom', shortName: 'GB', ianaTimeZone: 'Europe/London' },
  2: { id: 2, name: 'Pakistan', shortName: 'PK', ianaTimeZone: 'Asia/Karachi' },
};
const SHOP_ADDRESSES = {
  2: { id: 50, countryId: 1, zoneId: 10 },
  3: { id: 51, countryId: 2, zoneId: 20 },
};
const USERS = {
  2: { id: 2, userTypeId: 4, classifiedAsId: null },
  3: { id: 3, userTypeId: 4, classifiedAsId: null },
  16: { id: 16, userTypeId: 4, classifiedAsId: 1, employeeOff: 2, roleId: 8 },
  40: { id: 40, userTypeId: 1, classifiedAsId: null }, // a customer
};
const SERVICES_BY_SHOP = {
  2: [{ id: 1, status: true, service: { id: 7, name: 'Wash & Fold' } }],
  3: [{ id: 2, status: true, service: { id: 8, name: 'Dry Cleaning' } }],
};
const HOURS_BY_SHOP = {
  2: [{ id: 11, dayOfWeek: 'Monday', openTime: '08:00', closeTime: '18:00', status: true, userId: 2 }],
  3: [{ id: 12, dayOfWeek: 'Monday', openTime: '10:00', closeTime: '20:00', status: true, userId: 3 }],
};
const MACHINES = [{ id: 1, name: 'Washer' }];

const models = {
  machines: { findAll: async () => MACHINES },
  agentSelectServices: {
    findAll: async ({ where }) => SERVICES_BY_SHOP[where.agentServiceId] || [],
  },
  service: {},
  users: { findByPk: async (id) => USERS[id] || null },
  bussinessWorkingHours: {
    findAll: async ({ where }) => HOURS_BY_SHOP[where.userId] || [],
  },
  addressDb: { findOne: async ({ where }) => SHOP_ADDRESSES[where.userId] || null },
  countries: { findByPk: async (id) => COUNTRIES[id] || null },
  zone: { findOne: async () => null, findAll: async () => [] },
  cities: {},
};
// Platform bounds per country (the real service also seeds/reads its table).
const platformOperationalHoursService = {
  getAll: async (countryId) => ({ countryId, days: [{ dayOfWeek: 'Monday', openTime: '07:00', closeTime: '22:00' }] }),
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === '../models' || request === '../../models') return models;
  if (request === '../Admin/platformOperationalHoursService') return platformOperationalHoursService;
  return originalLoad.call(this, request, parent, isMain);
};

const { attachShopAgentContext } = require('../utils/shopAgentContext');
const agentController = require('../controllers/Agent/shopBusinessInfoController');
const adminController = require('../controllers/Admin/shopBusinessInformationController');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function recorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

/** Runs a handler; returns { res, err } (err = what asyncHandler would pass to next()). */
async function call(handler, req) {
  const res = recorder();
  try {
    await handler(req, res);
    return { res, err: null };
  } catch (err) {
    return { res, err };
  }
}

/** A request as validateAccessToken leaves it: req.user from the session + shop context. */
function signedIn(jwtClaims, params = {}) {
  return attachShopAgentContext({ user: jwtClaims, params, query: {}, body: {} });
}

const OWNER_2 = { id: 2, email: 'owner@example.test' };
const EMPLOYEE_16 = { id: 16, email: 'manager@example.test', employeeOff: 2, roleId: 8, classifiedAsId: 1 };
const OWNER_3 = { id: 3, email: 'other@example.test' };

const serviceNames = (body) => body.data.agentServices.map((s) => s.service.name);

(async () => {
  // ─── Agent app: business information ─────────────────────────────────────
  {
    const { res, err } = await call(agentController.getBusinessInformation, signedIn(OWNER_2, { userId: '2' }));
    assert.strictEqual(err, null);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(serviceNames(res.body), ['Wash & Fold'], 'owner 2 reads its own shop');
    assert.deepStrictEqual(res.body.data.allMachineInformation, MACHINES);
  }
  {
    // Installed builds send the signed-in user's own id (16) — the shop is still 2.
    const { res, err } = await call(agentController.getBusinessInformation, signedIn(EMPLOYEE_16, { userId: '16' }));
    assert.strictEqual(err, null);
    assert.deepStrictEqual(serviceNames(res.body), ['Wash & Fold'], 'employee 16 reads shop 2');
  }
  {
    // A signed-in shop cannot read another shop by changing the id: the param is ignored.
    const { res } = await call(agentController.getBusinessInformation, signedIn(OWNER_3, { userId: '2' }));
    assert.deepStrictEqual(serviceNames(res.body), ['Dry Cleaning'], 'owner 3 asking for :userId=2 gets its own shop');
  }
  {
    // A handler reached without a session fails closed (the route also requires one).
    const { res, err } = await call(agentController.getBusinessInformation, { params: { userId: '2' }, query: {} });
    assert.ok(err, 'no session → error');
    assert.strictEqual(err.statusCode, 401);
    assert.strictEqual(res.body, null, 'nothing is sent for an anonymous caller');
  }

  // ─── Agent app: working hours + platform hours (strict time-zone resolution) ──
  {
    // Before: `getCountryContextFromShopUserId(16)` → 422 "Shop 16 has no shop address".
    const { res, err } = await call(agentController.getWorkingHours, signedIn(EMPLOYEE_16, { userId: '16' }));
    assert.strictEqual(err, null, `employee working hours: ${err && err.message}`);
    assert.strictEqual(res.body.data.platformOperationalHours.countryId, 1, "shop 2's country bounds");
    assert.deepStrictEqual(res.body.data.bussinesWorkingHours, HOURS_BY_SHOP[2]);
  }
  {
    const { res } = await call(agentController.getWorkingHours, signedIn(OWNER_3, { userId: '2' }));
    assert.deepStrictEqual(res.body.data.bussinesWorkingHours, HOURS_BY_SHOP[3], 'param ignored for hours too');
    assert.strictEqual(res.body.data.platformOperationalHours.countryId, 2);
  }
  {
    const { res, err } = await call(agentController.getPlatformOperationalHours, signedIn(EMPLOYEE_16));
    assert.strictEqual(err, null, `employee platform hours: ${err && err.message}`);
    assert.strictEqual(res.body.data.countryId, 1, "employee 16 gets shop 2's country, not a 422");
  }
  {
    const { res } = await call(agentController.getPlatformOperationalHours, signedIn(OWNER_2));
    assert.strictEqual(res.body.data.countryId, 1);
  }

  // ─── Admin portal: any shop owner, zone-scoped for zone staff ────────────
  const adminReq = (agentId, scopedZoneId) => ({
    user: { id: 1 },
    params: { agentId: String(agentId) },
    query: {},
    body: {},
    ...(scopedZoneId != null ? { scopedZoneId } : {}),
  });
  {
    const { res, err } = await call(adminController.getShopBusinessInformation, adminReq(3));
    assert.strictEqual(err, null);
    assert.deepStrictEqual(serviceNames(res.body), ['Dry Cleaning'], 'platform admin reads any shop');
  }
  {
    const { res, err } = await call(adminController.getShopBusinessInformation, adminReq(2, 10));
    assert.strictEqual(err, null);
    assert.deepStrictEqual(serviceNames(res.body), ['Wash & Fold'], 'zone staff read a shop in their zone');
  }
  {
    const { res, err } = await call(adminController.getShopBusinessInformation, adminReq(3, 10));
    assert.strictEqual(err && err.statusCode, 404, 'zone staff: other-zone shop is not found');
    assert.strictEqual(res.body, null);
  }
  for (const notAShop of [16, 40, 999]) {
    const { err } = await call(adminController.getShopBusinessInformation, adminReq(notAShop));
    assert.strictEqual(err && err.statusCode, 404, `user ${notAShop} is not a shop owner → 404`);
  }
  for (const bad of ['abc', '0', '-2', '2.5']) {
    const { err } = await call(adminController.getShopBusinessInformation, adminReq(bad));
    assert.strictEqual(err && err.statusCode, 400, `agentId ${bad} → 400`);
  }

  Module._load = originalLoad;
  console.log('shopBusinessInfoAccess tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
