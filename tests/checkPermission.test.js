'use strict';

require('./stubSequelizeModels').install();

const assert = require('assert');
const checkPermission = require('../middlewares/checkPermission');

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

async function invoke(mw, req) {
  const res = responseRecorder();
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

function zoneRequest(overrides = {}) {
  return {
    user: { id: 42, zoneId: 7 },
    method: 'GET',
    path: '/allOrderDetails',
    headers: {},
    body: {},
    query: {},
    ...overrides,
  };
}

const zoneUser = { id: 42, classifiedAsId: 2, roleId: 5 };

function zoneDeps(overrides = {}) {
  return {
    async loadUser() {
      return zoneUser;
    },
    async loadZoneIdForAdmin() {
      return 7;
    },
    async loadFeatureIdByKey(featureKey) {
      return featureKey === 'orderManagement' ? 9 : null;
    },
    async loadPermission() {
      return null;
    },
    ...overrides,
  };
}

async function run() {
    checkPermission.clearCaches();
    const noPermRow = checkPermission.create(zoneDeps());
    const missing = await invoke(noPermRow, zoneRequest());
    assert.strictEqual(missing.nextCalled, false, 'zone token without a permission row must not continue');
    assert.strictEqual(missing.res.statusCode, 403);
    assert.strictEqual(missing.res.body.status, '0');
    assert.match(String(missing.res.body.error || ''), /read access/i);

    checkPermission.clearCaches();
    const falseRead = checkPermission.create(zoneDeps({
      async loadPermission() {
        return { create: false, read: false, update: false, delete: false };
      },
    }));
    const forbidden = await invoke(
      falseRead,
      zoneRequest({ user: { id: 43, zoneId: 7 } })
    );
    assert.strictEqual(forbidden.nextCalled, false, 'zone token with feature permission=false must be denied');
    assert.strictEqual(forbidden.res.statusCode, 403);
    assert.strictEqual(forbidden.res.body.message, 'Access Denied');

    checkPermission.clearCaches();
    const headerIgnored = checkPermission.create(zoneDeps({
      async loadPermission() {
        return { create: true, read: true, update: true, delete: true };
      },
    }));
    const unmapped = await invoke(
      headerIgnored,
      zoneRequest({
        path: '/not-a-mapped-admin-route',
        headers: { featureid: '9' },
        body: { featureId: 9 },
        query: { featureId: 9 },
      })
    );
    assert.strictEqual(unmapped.nextCalled, false, 'client featureid must not grant access on an unmapped route');
    assert.strictEqual(unmapped.res.statusCode, 403);
    assert.match(String(unmapped.res.body.error || ''), /No permission is configured/i);

    checkPermission.clearCaches();
    const allowed = checkPermission.create(zoneDeps({
      async loadPermission() {
        return { create: false, read: true, update: false, delete: false };
      },
    }));
    const granted = await invoke(
      allowed,
      zoneRequest({ user: { id: 44, zoneId: 7 } })
    );
    assert.strictEqual(granted.nextCalled, true);
    assert.strictEqual(granted.res.statusCode, null);

    checkPermission.clearCaches();
    const ownerMw = checkPermission.create({
      async loadUser() {
        return { id: 1, classifiedAsId: null, roleId: null };
      },
      async loadZoneIdForAdmin() {
        return null;
      },
      async loadFeatureIdByKey() {
        throw new Error('super admin must not resolve features');
      },
      async loadPermission() {
        throw new Error('super admin must not load permissions');
      },
    });
    const bypass = await invoke(
      ownerMw,
      zoneRequest({ user: { id: 1 }, headers: {} })
    );
    assert.strictEqual(bypass.nextCalled, true, 'super admin must still bypass feature checks');

    checkPermission.clearCaches();
    const shopDriverMw = checkPermission.create({
      async loadUser() {
        return { id: 327, classifiedAsId: 1, roleId: 6 };
      },
      async loadZoneIdForAdmin() {
        return null;
      },
      async loadFeatureIdByKey() {
        throw new Error('shop employee must not resolve admin features');
      },
      async loadPermission() {
        throw new Error('shop employee must not load admin permissions');
      },
    });
    const shopDriver = await invoke(
      shopDriverMw,
      zoneRequest({
        user: { id: 327, classifiedAsId: 1, roleId: 6, employeeOff: 309 },
        path: '/agentBookingFilters',
      })
    );
    assert.strictEqual(
      shopDriver.nextCalled,
      true,
      'laundry shop employee must bypass admin feature checks on agent routes'
    );

    console.log('checkPermission.test.js: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
