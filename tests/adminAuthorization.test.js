'use strict';

/**
 * Server-owned admin authorization:
 *  - zone token without featureId cannot list all orders
 *  - zone token cannot query another zone's report
 * Super admin (classifiedAsId === null) still bypasses.
 */

require('./stubSequelizeModels').install();

const assert = require('assert');
const checkPermission = require('../middlewares/checkPermission');
const enforceAdminZoneScope = require('../middlewares/enforceAdminZoneScope');
const { zoneIdFromRequest } = require('../utils/adminZoneScope');

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

async function invokeMiddleware(mw, req) {
    const res = responseRecorder();
    let continued = false;
    await mw(req, res, () => {
        continued = true;
    });
    return { res, continued };
}

async function run() {
    checkPermission.clearCaches();

    const loadUser = async () => ({
        id: 44,
        classifiedAsId: 2,
        roleId: 7,
    });

    const denyOrders = checkPermission.create({
        loadUser,
        loadZoneIdForAdmin: async () => 3,
        loadFeatureIdByKey: async (key) => (key === 'orderManagement' ? 10 : null),
        loadPermission: async () => null,
    });

    const zoneListReq = {
        method: 'GET',
        path: '/allOrderDetails',
        headers: {},
        query: {},
        body: {},
        user: { id: 44, zoneId: 3, classifiedAsId: 2, roleId: 7 },
    };

    const deniedList = await invokeMiddleware(denyOrders, zoneListReq);
    assert.strictEqual(deniedList.continued, false, 'zone token without featureId must not list orders');
    assert.strictEqual(deniedList.res.statusCode, 403);
    assert.strictEqual(deniedList.res.body.status, '0');

    checkPermission.clearCaches();

    const allowOrders = checkPermission.create({
        loadUser,
        loadZoneIdForAdmin: async () => 3,
        loadFeatureIdByKey: async (key) => (key === 'orderManagement' ? 10 : 99),
        loadPermission: async (featureId) => (
            Number(featureId) === 10
                ? { create: true, read: true, update: true, delete: true }
                : null
        ),
    });

    const allowedList = await invokeMiddleware(allowOrders, {
        ...zoneListReq,
        headers: { featureid: '99' },
        query: { featureId: '99' },
        body: { featureId: 99 },
    });
    assert.strictEqual(allowedList.continued, true, 'server-mapped orderManagement with role access must allow');
    assert.strictEqual(allowedList.res.statusCode, null);

    checkPermission.clearCaches();

    const clientHeaderDoesNotGrant = checkPermission.create({
        loadUser,
        loadZoneIdForAdmin: async () => 3,
        loadFeatureIdByKey: async (key) => (key === 'orderManagement' ? 10 : 99),
        loadPermission: async (featureId) => (
            Number(featureId) === 99
                ? { create: true, read: true, update: true, delete: true }
                : null
        ),
    });

    const spoofed = await invokeMiddleware(clientHeaderDoesNotGrant, {
        ...zoneListReq,
        headers: { featureid: '99' },
        query: { featureId: '99' },
    });
    assert.strictEqual(spoofed.continued, false, 'client featureid must not grant a different feature');
    assert.strictEqual(spoofed.res.statusCode, 403);

    checkPermission.clearCaches();

    const superAdminMw = checkPermission.create({
        loadUser: async () => ({ id: 1, classifiedAsId: null, roleId: null }),
        loadZoneIdForAdmin: async () => {
            throw new Error('super admin must not need a zone lookup');
        },
        loadFeatureIdByKey: async () => {
            throw new Error('super admin must bypass feature lookup');
        },
        loadPermission: async () => {
            throw new Error('super admin must bypass permission lookup');
        },
    });

    const superAdmin = await invokeMiddleware(superAdminMw, {
        method: 'GET',
        path: '/allOrderDetails',
        headers: {},
        query: { zoneId: '12' },
        body: {},
        user: { id: 1, email: 'admin@gmail.com', zoneId: '' },
    });
    assert.strictEqual(superAdmin.continued, true, 'platform super admin must keep full access');
    assert.strictEqual(superAdmin.res.statusCode, null);

    const otherZoneReport = {
        method: 'GET',
        path: '/reports/top-services',
        query: { zoneId: '99' },
        body: {},
        user: { id: 44, zoneId: 3, classifiedAsId: 2 },
        adminAuthz: {
            isPlatformAdmin: false,
            classifiedAsId: 2,
            roleId: 7,
            roleScope: 'zone',
            zoneId: 3,
        },
    };
    const reportDenied = await invokeMiddleware(enforceAdminZoneScope, otherZoneReport);
    assert.strictEqual(reportDenied.continued, false, 'zone token must not query another zone report');
    assert.strictEqual(reportDenied.res.statusCode, 403);
    assert.match(String(reportDenied.res.body.error), /does not match/i);

    const scopedReport = {
        method: 'GET',
        path: '/reports/top-services',
        query: {},
        body: {},
        user: { id: 44, zoneId: 3, classifiedAsId: 2 },
        adminAuthz: {
            isPlatformAdmin: false,
            classifiedAsId: 2,
            roleId: 7,
            roleScope: 'zone',
            zoneId: 3,
        },
    };
    const reportForced = await invokeMiddleware(enforceAdminZoneScope, scopedReport);
    assert.strictEqual(reportForced.continued, true);
    assert.strictEqual(scopedReport.query.zoneId, '3');
    assert.strictEqual(scopedReport.scopedZoneId, 3);

    const reportReq = {
        query: { zoneId: '99', period: 'all' },
        scopedZoneId: 3,
    };
    const capturedFilters = { zoneId: zoneIdFromRequest(reportReq) };
    assert.strictEqual(capturedFilters.zoneId, 3);
    assert.notStrictEqual(capturedFilters.zoneId, 99);

    const platformFilter = await invokeMiddleware(enforceAdminZoneScope, {
        method: 'GET',
        path: '/reports/top-services',
        query: { zoneId: '12' },
        user: { id: 1, email: 'admin@gmail.com' },
        adminAuthz: {
            isPlatformAdmin: true,
            classifiedAsId: null,
            zoneId: null,
        },
    });
    assert.strictEqual(platformFilter.continued, true);
    assert.strictEqual(platformFilter.res.statusCode, null);

    const platformStaffNoZone = await invokeMiddleware(enforceAdminZoneScope, {
        method: 'GET',
        path: '/adminDashboard',
        query: {},
        body: {},
        user: { id: 55, classifiedAsId: 2, roleId: 99, roleScope: 'platform' },
        adminAuthz: {
            isPlatformAdmin: false,
            classifiedAsId: 2,
            roleId: 99,
            roleScope: 'platform',
            zoneId: null,
        },
    });
    assert.strictEqual(platformStaffNoZone.continued, true, 'platform staff without a zone must pass zone middleware');
    assert.strictEqual(platformStaffNoZone.res.statusCode, null);

    const zoneStaffNoZone = await invokeMiddleware(enforceAdminZoneScope, {
        method: 'GET',
        path: '/adminDashboard',
        query: {},
        body: {},
        user: { id: 44, classifiedAsId: 2, roleId: 7, roleScope: 'zone' },
        adminAuthz: {
            isPlatformAdmin: false,
            classifiedAsId: 2,
            roleId: 7,
            roleScope: 'zone',
            zoneId: null,
        },
    });
    assert.strictEqual(zoneStaffNoZone.continued, false, 'zone staff without a zone must be denied');
    assert.strictEqual(zoneStaffNoZone.res.statusCode, 403);
    assert.match(String(zoneStaffNoZone.res.body.error), /no zone assigned/i);

    checkPermission.clearCaches();
    const platformStaffDash = checkPermission.create({
        loadUser: async () => ({
            id: 55,
            classifiedAsId: 2,
            roleId: 99,
            roleScope: 'platform',
        }),
        loadZoneIdForAdmin: async () => {
            throw new Error('platform staff must not need a zone lookup');
        },
        loadFeatureIdByKey: async (key) => (key === 'dashboard' ? 1 : null),
        loadPermission: async () => ({ create: false, read: true, update: false, delete: false }),
    });
    const dashOk = await invokeMiddleware(platformStaffDash, {
        method: 'GET',
        path: '/adminDashboard',
        headers: {},
        query: {},
        body: {},
        user: { id: 55, classifiedAsId: 2, roleId: 99, roleScope: 'platform' },
    });
    assert.strictEqual(dashOk.continued, true, 'platform staff with dashboard read must reach GET /adminDashboard');
    assert.strictEqual(dashOk.res.statusCode, null);

    console.log('adminAuthorization tests passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
