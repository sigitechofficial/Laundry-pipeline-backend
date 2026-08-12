/**
 * Periodic cleanup of inactive liveTracking RTDB nodes.
 */

const { cleanupStaleLiveTrackingSessions } = require('../utils/liveTrackingRtdb');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

let cleanupTimer = null;

function startLiveTrackingCleanupJob() {
  if (cleanupTimer) return;

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
