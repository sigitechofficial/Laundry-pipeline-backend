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
 *
 * Since 2026-11-21 every new booking also stores `policySnapshot`: a copy of all three rule sets
 * at booking. Cancel, reschedule and no-show use that copy first, so editing a policy only changes
 * it for new orders. Bookings made before have no copy and keep the lookups above.
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

/** The rules a policy record holds, as plain data (no ids of config rows, no timestamps). */
function rulesOf(policyRecord, configAs) {
    if (!policyRecord) return null;
    const plain = typeof policyRecord.toJSON === 'function' ? policyRecord.toJSON() : policyRecord;
    const config = plain[configAs];
    if (!config) return null;
    const { id: _id, policyId: _policyId, createdAt: _c, updatedAt: _u, ...rules } = config;
    return { id: plain.id, name: plain.name, [configAs]: rules };
}

/**
 * Copy the cancellation, reschedule and no-show rules in force now onto the booking, so a later
 * edit of a policy never changes an order that is already booked. Written once, at booking.
 */
async function snapshotPoliciesOnBooking(bookingId, zoneId) {
    const existing = await booking.findByPk(bookingId, { attributes: ['id', 'policySnapshot'] });
    if (!existing || existing.policySnapshot) return existing?.policySnapshot || null;
    const { getActiveNoShowPolicySafe } = require('./safeNoShowPolicyQuery');
    const [cancellation, reschedule, noShow] = await Promise.all([
        activePoliciesService.getActiveCancellationPolicy(zoneId),
        activePoliciesService.getActiveReschedulePolicy(zoneId),
        getActiveNoShowPolicySafe(zoneId),
    ]);
    const snapshot = {
        takenAt: new Date().toISOString(),
        cancellation: rulesOf(cancellation, 'cancellationConfig'),
        reschedule: rulesOf(reschedule, 'rescheduleConfig'),
        noShow: rulesOf(noShow, 'noShowConfig'),
    };
    await booking.update({ policySnapshot: snapshot }, { where: { id: bookingId } });
    return snapshot;
}

/** The booking's copied rules for one family ('cancellation' | 'reschedule' | 'noShow'), or null. */
function snapshotPolicy(bookingData, family) {
    const snap = bookingData?.policySnapshot;
    const parsed = typeof snap === 'string' ? (() => { try { return JSON.parse(snap); } catch { return null; } })() : snap;
    return parsed?.[family] || null;
}

module.exports = {
    attachCancellationPolicyOnBooking,
    attachNoShowPolicyOnBooking,
    snapshotPoliciesOnBooking,
    snapshotPolicy,
};
