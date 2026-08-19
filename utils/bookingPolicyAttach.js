const { booking } = require('../models');
const activePoliciesService = require('../services/Admin/activePoliciesService');

/**
 * Snapshot rules (keep these three families consistent in comments + callers):
 *
 * - No-show: freeze `bookings.noShowPolicyId` at booking create (and again on
 *   first attempt if still empty). Later admin edits do not change in-flight orders.
 * - Cancellation: freeze `bookings.cancellationPolicyId` at booking create.
 *   First cancel uses the snapshot when present; live policy is only a fallback.
 * - Reschedule: always live. There is no `reschedulePolicyId` column. Lookup
 *   must use activePoliciesService (zone row, then global `zoneId: null`).
 */

/**
 * Attach the active cancellation policy to a booking (create or first cancel).
 * Only persists when a real policy record exists.
 */
async function attachCancellationPolicyOnBooking(bookingId, zoneId) {
    const existing = await booking.findByPk(bookingId, {
        attributes: ['id', 'cancellationPolicyId'],
    });
    if (existing?.cancellationPolicyId) return existing.cancellationPolicyId;

    const activePolicy = await activePoliciesService.getActiveCancellationPolicy(zoneId);
    if (!activePolicy?.id) return null;

    await booking.update(
        { cancellationPolicyId: activePolicy.id },
        { where: { id: bookingId } }
    );
    return activePolicy.id;
}

/**
 * Attach the active no-show policy to a booking (create or first attempt).
 * Skips if a snapshot ID is already present. Only persists when a real policy exists.
 */
async function attachNoShowPolicyOnBooking(bookingId, zoneId) {
    const existing = await booking.findByPk(bookingId, {
        attributes: ['id', 'noShowPolicyId'],
    });
    if (existing?.noShowPolicyId) return existing.noShowPolicyId;

    const activePolicy = await activePoliciesService.getActiveNoShowPolicy(zoneId);
    if (!activePolicy?.id) return null;

    await booking.update(
        { noShowPolicyId: activePolicy.id },
        { where: { id: bookingId } }
    );
    return activePolicy.id;
}

module.exports = {
    attachCancellationPolicyOnBooking,
    attachNoShowPolicyOnBooking,
};
