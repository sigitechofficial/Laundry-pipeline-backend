/**
 * Lightweight self-check for live-tracking module wiring (no RTDB network required).
 * Run: node scripts/liveTrackingSmoke.js
 */

const assert = require('assert');

function run() {
  const rtdb = require('../utils/liveTrackingRtdb');
  const auth = require('../utils/liveTrackingAuth');
  const cleanup = require('../services/liveTrackingCleanupService');

  assert.strictEqual(typeof rtdb.openLiveTrackingSession, 'function');
  assert.strictEqual(typeof rtdb.closeLiveTrackingSession, 'function');
  assert.strictEqual(typeof rtdb.syncLiveTrackingForBookingStatus, 'function');
  assert.strictEqual(typeof rtdb.reassignLiveTrackingAgent, 'function');
  assert.strictEqual(typeof rtdb.cleanupStaleLiveTrackingSessions, 'function');
  assert.strictEqual(typeof auth.createLiveTrackingCustomToken, 'function');
  assert.strictEqual(auth.firebaseUidForRole('customer', 42), 'customer_42');
  assert.strictEqual(auth.firebaseUidForRole('agent', 7), 'agent_7');
  assert.strictEqual(typeof cleanup.startLiveTrackingCleanupJob, 'function');
  assert.ok(rtdb.CLOSE_STATUSES.has(5));
  assert.ok(rtdb.CLOSE_STATUSES.has(14));
  assert.ok(rtdb.CLOSE_STATUSES.has(19));
  assert.ok(rtdb.CLOSE_STATUSES.has(3));
  assert.ok(rtdb.CLOSE_STATUSES.has(15));
  assert.ok(rtdb.CLOSE_STATUSES.has(18));
  assert.strictEqual(rtdb.ACTIVE_STATUS_PICKUP, 4);
  assert.strictEqual(rtdb.ACTIVE_STATUS_DELIVERY, 13);

  const rules = require('../firebase/database.rules.json');
  assert.ok(rules.rules.liveTracking);
  assert.ok(rules.rules.liveTracking.$bookingId);
  assert.strictEqual(rules.rules.liveTracking.$bookingId.meta['.write'], false);
  assert.ok(rules.rules.liveTracking.$bookingId.location['.write']);
  assert.ok(rules.rules.liveTracking.$bookingId.location['.validate']);

  console.log('liveTrackingSmoke: OK');
}

run();
