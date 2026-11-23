'use strict';

/**
 * The fake-GPS live tracking demo (POST /agent/live-tracking/:id/demo-stream) is QA
 * tooling: it shows the customer a simulated driver position on their Live map.
 * In production that would let any assigned driver fake their location, so it is
 * off unless explicitly enabled. Other environments keep it on by default.
 *
 *   LIVE_TRACKING_DEMO_ENABLED=true|false  — explicit override (any environment)
 */
function isLiveTrackingDemoEnabled(env = process.env) {
  const flag = String(env.LIVE_TRACKING_DEMO_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV !== 'production';
}

module.exports = { isLiveTrackingDemoEnabled };
