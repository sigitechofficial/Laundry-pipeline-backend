'use strict';

const { agentComplianceEvent, booking } = require('../../models');

const ACTION_TO_BOOKING_FLAG = {
  arrived_pickup: 'pickupArrivedGeofenceOverride',
  arrived_delivery: 'deliveryArrivedGeofenceOverride',
  complete_pickup: 'pickupCompleteGeofenceOverride',
  complete_delivery: 'deliveryCompleteGeofenceOverride',
};

/**
 * Append-only compliance audit row. Never throws to callers of status updates —
 * logging failures are warned only.
 */
async function recordComplianceEvent(payload = {}) {
  try {
    const row = await agentComplianceEvent.create({
      bookingId: payload.bookingId,
      actorUserId: payload.actorUserId || null,
      shopId: payload.shopId || null,
      action: payload.action,
      withinGeofence:
        payload.withinGeofence == null ? null : Boolean(payload.withinGeofence),
      overrideUsed: Boolean(payload.overrideUsed),
      geofenceBypassedGlobal: Boolean(payload.geofenceBypassedGlobal),
      driverLat: payload.driverLat ?? null,
      driverLng: payload.driverLng ?? null,
      customerLat: payload.customerLat ?? null,
      customerLng: payload.customerLng ?? null,
      distanceMeters:
        payload.distanceMeters == null
          ? null
          : Math.round(Number(payload.distanceMeters)),
      requiredRadiusMeters:
        payload.requiredRadiusMeters == null
          ? null
          : Math.round(Number(payload.requiredRadiusMeters)),
      failInstructionSetId: payload.failInstructionSetId || null,
      failInstructionSetVersion: payload.failInstructionSetVersion || null,
      acknowledgedItemSnapshot: payload.acknowledgedItemSnapshot || null,
      overrideReason: payload.overrideReason
        ? String(payload.overrideReason).slice(0, 500)
        : null,
    });

    const flag = ACTION_TO_BOOKING_FLAG[payload.action];
    if (flag && payload.overrideUsed && !payload.geofenceBypassedGlobal) {
      await booking.update(
        { [flag]: true },
        { where: { id: payload.bookingId } }
      );
    }

    return row;
  } catch (err) {
    console.warn(
      '[agentCompliance] recordComplianceEvent failed:',
      err?.message || err
    );
    return null;
  }
}

module.exports = {
  recordComplianceEvent,
  ACTION_TO_BOOKING_FLAG,
};
