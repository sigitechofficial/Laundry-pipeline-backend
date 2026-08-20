'use strict';

const assert = require('assert');
const {
    isPlatformAdmin,
    parseZoneId,
    resolveScopedZone,
    applyAdminZoneScope,
    zoneIdFromRequest,
} = require('./adminZoneScope');

function run() {
    assert.strictEqual(isPlatformAdmin(null), true);
    assert.strictEqual(isPlatformAdmin(undefined), true);
    assert.strictEqual(isPlatformAdmin(2), false);
    assert.strictEqual(parseZoneId(''), null);
    assert.strictEqual(parseZoneId('4'), 4);

    const platform = resolveScopedZone({
        classifiedAsId: null,
        jwtZoneId: '',
        clientZoneId: '9',
    });
    assert.deepStrictEqual(platform, { ok: true, zoneId: 9, forced: false });

    const omitted = resolveScopedZone({
        classifiedAsId: 2,
        jwtZoneId: 3,
        clientZoneId: undefined,
    });
    assert.deepStrictEqual(omitted, { ok: true, zoneId: 3, forced: true });

    const mismatch = resolveScopedZone({
        classifiedAsId: 2,
        jwtZoneId: 3,
        clientZoneId: '99',
    });
    assert.strictEqual(mismatch.ok, false);
    assert.strictEqual(mismatch.status, 403);
    assert.match(mismatch.error, /does not match/i);

    const noZone = resolveScopedZone({
        classifiedAsId: 2,
        jwtZoneId: null,
        clientZoneId: undefined,
    });
    assert.strictEqual(noZone.ok, false);
    assert.match(noZone.error, /no zone assigned/i);

    const req = {
        query: {},
        user: { classifiedAsId: 2, zoneId: 7 },
        adminAuthz: {
            isPlatformAdmin: false,
            classifiedAsId: 2,
            zoneId: 7,
        },
    };
    const applied = applyAdminZoneScope(req);
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(req.query.zoneId, '7');
    assert.strictEqual(req.scopedZoneId, 7);
    assert.strictEqual(zoneIdFromRequest(req), 7);

    const foreign = {
        query: { zoneId: '99' },
        adminAuthz: { isPlatformAdmin: false, classifiedAsId: 2, zoneId: 7 },
    };
    const rejected = applyAdminZoneScope(foreign);
    assert.strictEqual(rejected.ok, false);

    const superAdmin = {
        query: { zoneId: '12' },
        adminAuthz: { isPlatformAdmin: true, classifiedAsId: null, zoneId: null },
    };
    const leftAlone = applyAdminZoneScope(superAdmin);
    assert.strictEqual(leftAlone.ok, true);
    assert.strictEqual(superAdmin.query.zoneId, '12');
    assert.strictEqual(superAdmin.scopedZoneId, undefined);

    console.log('adminZoneScope tests passed');
}

run();
