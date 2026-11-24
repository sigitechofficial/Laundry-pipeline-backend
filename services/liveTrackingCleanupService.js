/**
 * Periodic cleanup of inactive liveTracking RTDB nodes, and reconciliation of the
 * cross-project GPS relays (utils/liveTrackingBridge.js) so a restart resumes every
 * running trip's relay.
 */

const { cleanupStaleLiveTrackingSessions } = require('../utils/liveTrackingRtdb');
const { reconcileBridges } = require('../utils/liveTrackingBridge');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_BRIDGE_RECONCILE_MS = 2 * 60 * 1000; // 2 minutes

let cleanupTimer = null;
let bridgeTimer = null;

function startBridgeReconcile() {
  if (bridgeTimer) return;
  const intervalMs = Number(
    process.env.LIVE_TRACKING_BRIDGE_RECONCILE_MS || DEFAULT_BRIDGE_RECONCILE_MS
  );
  const run = async () => {
    try {
      await reconcileBridges();
    } catch (err) {
      console.error('[liveTrackingBridge] reconcile failed:', err.message);
    }
  };
  // Soon after boot: a restart must not leave a running trip unrelayed for long.
  setTimeout(run, 10 * 1000).unref?.();
  bridgeTimer = setInterval(run, intervalMs);
  bridgeTimer.unref?.();
}

function startLiveTrackingCleanupJob() {
  if (cleanupTimer) return;
  startBridgeReconcile();

  const intervalMs = Number(
    process.env.LIVE_TRACKING_CLEANUP_INTERVAL_MS || DEFAULT_INTERVAL_MS
  );
  const maxAgeMs = Number(
    process.env.LIVE_TRACKING_CLEANUP_MAX_AGE_MS || DEFAULT_MAX_AGE_MS
  );

  const run = async () => {
    try {
      const result = await cleanupStaleLiveTrackingSessions({ maxAgeMs });
      if (result?.deleted > 0) {
        console.log(`[liveTrackingCleanup] pruned ${result.deleted} sessions`);
      }
    } catch (err) {
      console.error('[liveTrackingCleanup] failed:', err.message);
    }
  };

  // Stagger first run slightly after boot
  setTimeout(run, 45 * 1000);
  cleanupTimer = setInterval(run, intervalMs);
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  console.log(
    `[liveTrackingCleanup] started intervalMs=${intervalMs} maxAgeMs=${maxAgeMs}`
  );
}

module.exports = {
  startLiveTrackingCleanupJob,
};
