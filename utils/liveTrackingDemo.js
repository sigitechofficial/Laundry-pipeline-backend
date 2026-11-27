'use strict';

/**
 * The fake-GPS live tracking demo ("Start demo tracking" in the agent app, and
 * POST /agent/live-tracking/:id/demo-stream) is QA tooling: it shows the
 * customer a simulated driver position on their Live map.
 *
 * Production: on only while an admin has "Bypass geofence distance check" on
 * (Policies → Runtime checks), the same testing switch, so turning it off
 * hides the demo again. Other environments: on.
 *
 *   LIVE_TRACKING_DEMO_ENABLED=false  — hard off in every environment
 *   LIVE_TRACKING_DEMO_ENABLED=true   — on outside production (production still
 *                                       follows the admin switch)
 */
function envFlag(env) {
    return String(env.LIVE_TRACKING_DEMO_ENABLED ?? '').trim().toLowerCase();
}

/** Sync part: is the demo allowed by the environment alone (non-production)? */
function isLiveTrackingDemoEnabled(env = process.env) {
    const flag = envFlag(env);
    if (flag === 'false') return false;
    return env.NODE_ENV !== 'production';
}

/**
 * Whether the demo is available now.
 * @param {{ env?: object, geofenceBypassActive?: () => Promise<boolean> }} [deps]
 */
async function isLiveTrackingDemoAllowed(deps = {}) {
    const env = deps.env || process.env;
    if (envFlag(env) === 'false') return false;
    if (env.NODE_ENV !== 'production') return true;
    const bypass = deps.geofenceBypassActive
        || require('./geofenceBypass').isGeofenceBypassActive;
    try {
        return Boolean(await bypass());
    } catch (err) {
        console.warn('[liveTrackingDemo] could not read the admin switch:', err?.message || err);
        return false;
    }
}

module.exports = { isLiveTrackingDemoEnabled, isLiveTrackingDemoAllowed };
