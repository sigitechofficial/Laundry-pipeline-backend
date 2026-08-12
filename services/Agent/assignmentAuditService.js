const { bookingAssignmentEvent } = require('../../models');

/**
 * Persist booking staff assignment audit rows.
 */
class AssignmentAuditService {
    /**
     * @param {{
     *   bookingId: number,
     *   assignmentType: 'pickup'|'delivery',
     *   action: 'assign'|'unassign'|'reassign'|'auto',
     *   fromUserId?: number|null,
     *   toUserId?: number|null,
     *   actedByUserId: number,
     *   source?: 'manual'|'auto'|'self_return',
     *   reasonId?: number|null,
     *   reasonText?: string|null,
     *   note?: string|null,
     * }} payload
     */
    async recordEvent(payload) {
        const {
            bookingId,
            assignmentType,
            action,
            fromUserId = null,
            toUserId = null,
            actedByUserId,
            source = 'manual',
            reasonId = null,
            reasonText = null,
            note = null,
        } = payload || {};

        if (!bookingId || !assignmentType || !action || actedByUserId == null) {
            console.error('[assignmentAudit] missing required fields', payload);
            return null;
        }

        const normalizedSource =
            source === 'auto' || source === 'self_return' ? source : 'manual';

        return bookingAssignmentEvent.create({
            bookingId: Number(bookingId),
            assignmentType: String(assignmentType).toLowerCase(),
            action: String(action).toLowerCase(),
            fromUserId: fromUserId != null ? Number(fromUserId) : null,
            toUserId: toUserId != null ? Number(toUserId) : null,
            actedByUserId: Number(actedByUserId),
            source: normalizedSource,
            reasonId: reasonId != null ? Number(reasonId) : null,
            reasonText: reasonText != null ? String(reasonText).slice(0, 255) : null,
            note: note != null && String(note).trim() !== '' ? String(note).trim() : null,
        });
    }
}

module.exports = new AssignmentAuditService();
