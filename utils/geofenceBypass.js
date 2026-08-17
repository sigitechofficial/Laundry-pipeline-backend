/**
 * Geofence bypass for QA / testing.
 *
 * Source of truth is `platformRuntimeSettings.geofenceBypassEnabled` (admin panel).
 * Env `GEOFENCE_BYPASS_ENABLED` is the fallback when the DB row is missing.
 */

const runtimeSettingsService = require("../services/Admin/runtimeSettingsService");

async function isGeofenceBypassActive() {
  const enabled = await runtimeSettingsService.getBoolean("geofenceBypassEnabled");
  if (enabled) {
    console.warn("[geofenceBypass] Geofence bypass active (admin/runtime setting)");
  }
  return enabled;
}

module.exports = {
  isGeofenceBypassActive,
};
