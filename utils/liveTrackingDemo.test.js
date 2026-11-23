'use strict';

const assert = require('assert/strict');
const { isLiveTrackingDemoEnabled } = require('./liveTrackingDemo');

assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'production' }), false, 'off in production by default');
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'development' }), true);
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'test' }), true);
assert.equal(isLiveTrackingDemoEnabled({}), true);
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'production', LIVE_TRACKING_DEMO_ENABLED: 'true' }), true, 'explicit opt-in');
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'development', LIVE_TRACKING_DEMO_ENABLED: 'false' }), false, 'explicit opt-out');
assert.equal(isLiveTrackingDemoEnabled({ NODE_ENV: 'production', LIVE_TRACKING_DEMO_ENABLED: 'yes' }), false, 'only true/false count');

console.log('liveTrackingDemo.test.js: all assertions passed');
