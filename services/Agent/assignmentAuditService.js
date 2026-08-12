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
        });
    }
}

module.exports = new AssignmentAuditService();
