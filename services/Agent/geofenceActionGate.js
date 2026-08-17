'use strict';

const {
  evaluateDriverGeofenceForAction,
} = require('../../utils/driverGeofence');
const { recordComplianceEvent } = require('../Agent/agentComplianceService');

/**
 * Soft geofence for Arrived / Complete + compliance event write.
 * Throws GeofenceOutOfRangeError when outside and not confirmed.
 */
async function gateGeofenceAndRecord({
  bookingId,
  leg,
  action,
  driverLat,
  driverLng,
  geofenceBypassToken,
  confirmOutOfGeofence,
  overrideReason,
  actorUserId,
  shopId,
}) {
  const geo = await evaluateDriverGeofenceForAction({
    bookingId,
    leg,
    driverLat,
    driverLng,
    geofenceBypassToken,
    confirmOutOfGeofence,
  });

  await recordComplianceEvent({
    bookingId,
    actorUserId,
    shopId,
    action,
    withinGeofence: geo.overrideUsed ? false : Boolean(geo.withinGeofence),
    overrideUsed: Boolean(geo.overrideUsed),
    geofenceBypassedGlobal: Boolean(geo.geofenceBypassed),
    driverLat,
    driverLng,
    customerLat: geo.customerLat,
    customerLng: geo.customerLng,
    distanceMeters: geo.distanceMeters,
    requiredRadiusMeters: geo.requiredRadiusMeters,
    overrideReason,
  });

  return geo;
}

module.exports = {
  gateGeofenceAndRecord,
};
