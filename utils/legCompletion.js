'use strict';

const assignmentAuditService = require('../services/Agent/assignmentAuditService');
const { booking } = require('../models');

/**
 * Freeze who completed a pickup or delivery leg and audit it.
 * Idempotent if the snapshot is already set.
 *
 * @param {{
 *   bookingId: number,
 *   leg: 'pickup'|'delivery',
 *   actorUserId: number,
 *   fallbackAssigneeId?: number|null,
 * }} opts
 */
async function recordLegCompletion({
  bookingId,
  leg,
  actorUserId,
  fallbackAssigneeId = null,
}) {
  const id = Number(bookingId);
  const actor = Number(actorUserId);
  if (!id || !actor || Number.isNaN(id) || Number.isNaN(actor)) {
    console.warn('[legCompletion] missing bookingId/actorUserId', {
      bookingId,
      actorUserId,
    });
    return null;
  }

  const isDelivery = String(leg).toLowerCase() === 'delivery';
  const byField = isDelivery
    ? 'deliveryCompletedByUserId'
    : 'pickupCompletedByUserId';
  const atField = isDelivery ? 'deliveryCompletedAt' : 'pickupCompletedAt';
  const assignmentType = isDelivery ? 'delivery' : 'pickup';

  const row = await booking.findByPk(id, {
    attributes: [
      'id',
      'driverId',
      'deliveryDriverId',
      'pickupCompletedByUserId',
      'deliveryCompletedByUserId',
    ],
  });
  if (!row) return null;

  if (row[byField] != null) {
    return {
      alreadySet: true,
      completedByUserId: Number(row[byField]),
    };
  }

  const fallback =
    fallbackAssigneeId != null
      ? Number(fallbackAssigneeId)
      : isDelivery
        ? row.deliveryDriverId != null
          ? Number(row.deliveryDriverId)
          : null
        : row.driverId != null
          ? Number(row.driverId)
          : null;

  const completedBy = actor || fallback;
  const now = new Date();

  await booking.update(
    {
      [byField]: completedBy,
      [atField]: now,
    },
    { where: { id } }
  );

  try {
    await assignmentAuditService.recordEvent({
      bookingId: id,
      assignmentType,
      action: 'complete',
      fromUserId: null,
      toUserId: completedBy,
      actedByUserId: actor,
      source: 'manual',
    });
  } catch (err) {
    console.warn(
      '[legCompletion] audit failed:',
      err?.message || err
    );
  }

  return { alreadySet: false, completedByUserId: completedBy, at: now };
}

module.exports = {
  recordLegCompletion,
};
