/**
 * Geofence bypass for QA / staging only.
 *
 * Enable in .env:
 *   GEOFENCE_BYPASS_ENABLED=true
 *   GEOFENCE_BYPASS_SECRET=your-staging-secret
 *
 * Agent app sends matching token:
 *   GET  ?geofenceBypassToken=your-staging-secret
 *   POST/PATCH body: { geofenceBypassToken: "your-staging-secret" }
 *
 * Production: bypass is ignored unless both env flags are set AND token matches.
 * Never set GEOFENCE_BYPASS_ENABLED on production.
 */

function isTruthyEnv(value) {
    return ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isGeofenceBypassActive(bypassToken) {
    if (!isTruthyEnv(process.env.GEOFENCE_BYPASS_ENABLED)) {
        return false;
    }

    const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
    const secret = String(process.env.GEOFENCE_BYPASS_SECRET || '').trim();
    const token = String(bypassToken || '').trim();

    if (nodeEnv === 'production') {
        console.warn(
            '[geofenceBypass] GEOFENCE_BYPASS_ENABLED is set on production — bypass disabled'
        );
        return false;
    }

    if (!secret) {
        console.warn(
            '[geofenceBypass] GEOFENCE_BYPASS_ENABLED without GEOFENCE_BYPASS_SECRET — bypass open (non-production only)'
        );
        return true;
    }

    if (!token || token !== secret) {
        return false;
    }

    console.warn('[geofenceBypass] Geofence bypass active for this request (QA)');
    return true;
}

module.exports = {
    isGeofenceBypassActive,
};
