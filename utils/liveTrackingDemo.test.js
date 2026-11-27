'use strict';

const assert = require('assert/strict');
const { isLiveTrackingDemoEnabled, isLiveTrackingDemoAllowed } = require('./liveTrackingDemo');

assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'production' }), false, 'off in production by default');
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'development' }), true);
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'test' }), true);
assert.equal(isLiveTrackingDemoEnabled({}), true);
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'development', LIVE_TRACKING_DEMO_ENABLED: 'false' }), false, 'explicit opt-out');

(async () => {
    const on = async () => true;
    const off = async () => false;
    const boom = async () => { throw new Error('db down'); };
    const prod = { NODE_ENV: 'production' };
    assert.equal(await isLiveTrackingDemoAllowed({ env: prod, geofenceBypassActive: on }), true, 'production: admin switch on');
    assert.equal(await isLiveTrackingDemoAllowed({ env: prod, geofenceBypassActive: off }), false, 'production: admin switch off');
    assert.equal(
        await isLiveTrackingDemoAllowed({ env: { ...prod, LIVE_TRACKING_DEMO_ENABLED: 'true' }, geofenceBypassActive: off }),
        false,
        'production: env true does not override the admin switch'
    );
    assert.equal(
        await isLiveTrackingDemoAllowed({ env: { ...prod, LIVE_TRACKING_DEMO_ENABLED: 'false' }, geofenceBypassActive: on }),
        false,
        'env false is a hard off'
    );
    assert.equal(await isLiveTrackingDemoAllowed({ env: prod, geofenceBypassActive: boom }), false, 'switch unreadable -> off');
    assert.equal(await isLiveTrackingDemoAllowed({ env: { NODE_ENV: 'development' }, geofenceBypassActive: off }), true, 'non-production always on');
    console.log('liveTrackingDemo.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
