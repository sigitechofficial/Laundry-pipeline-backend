/**
 * Geofence bypass toggle for QA / testing.
 *
 * .env only:
 *   GEOFENCE_BYPASS_ENABLED=true   → skip distance check
 *   GEOFENCE_BYPASS_ENABLED=false  → normal geofence (default)
 *
 * Restart server after changing .env (pm2 restart ... --update-env).
 * Turn OFF on production when not actively testing.
 */

function isTruthyEnv(value) {
    return ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isGeofenceBypassActive() {
    if (!isTruthyEnv(process.env.GEOFENCE_BYPASS_ENABLED)) {
        return false;
    }
    console.warn('[geofenceBypass] Geofence bypass active (GEOFENCE_BYPASS_ENABLED=true)');
    return true;
}

module.exports = {
    isGeofenceBypassActive,
};
