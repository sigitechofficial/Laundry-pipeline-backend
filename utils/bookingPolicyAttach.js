const { booking } = require('../models');
const activePoliciesService = require('../services/Admin/activePoliciesService');

/**
 * Attach the active cancellation policy to a booking (e.g. on cancel).
 * Only persists when a real policy record exists.
 */
async function attachCancellationPolicyOnBooking(bookingId, zoneId) {
    const activePolicy = await activePoliciesService.getActiveCancellationPolicy(zoneId);
    if (!activePolicy?.id) return null;

    await booking.update(
        { cancellationPolicyId: activePolicy.id },
        { where: { id: bookingId } }
    );
    return activePolicy.id;
}

/**
 * Attach the active no-show policy to a booking (e.g. on no-show event).
 * Only persists when a real policy record exists.
 */
async function attachNoShowPolicyOnBooking(bookingId, zoneId) {
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
