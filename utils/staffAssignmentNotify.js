const { sendEvent } = require('../socket_io');
const { sendNotification } = require('./notification');

/**
 * Notify staff when a pickup/delivery leg is assigned or taken away.
 * Fire-and-forget — failures must not roll back assign/unassign.
 */
async function notifyStaffAssignmentChange({
    bookingId,
    orderTrackId,
    assignmentType,
    action,
    toUserId,
    fromUserId,
    shopOwnerUserId,
}) {
    const numericBookingId = Number(bookingId);
    const orderLabel = orderTrackId || String(bookingId);
    const leg = assignmentType === 'delivery' ? 'delivery' : 'pickup';
    const ownerId =
        shopOwnerUserId != null ? Number(shopOwnerUserId) : null;

    const notifyUser = async (userId, type, title, body) => {
        if (userId == null) return;
        const id = Number(userId);
        if (!id || Number.isNaN(id)) return;
        // Do not push shop-owner "held" noise as a staff job notification
        if (ownerId != null && id === ownerId && type === 'staffJobAssigned') {
            return;
        }
        try {
            await sendEvent(id, {
                type,
                data: {
                    bookingId: numericBookingId,
                    assignmentType: leg,
                    action,
                    message: body,
                },
            });
        } catch (err) {
            console.warn('[staffAssignNotify] sendEvent failed:', err?.message || err);
        }
        try {
            await sendNotification(id, title, body, {
                bookingId: numericBookingId,
                type,
                assignmentType: leg,
            });
        } catch (err) {
            console.warn(
                '[staffAssignNotify] sendNotification failed:',
                err?.message || err
            );
        }
    };

    if (action === 'unassign' || action === 'self_return') {
        await notifyUser(
            fromUserId,
            'staffJobUnassigned',
            'Job returned to shop',
            `Your ${leg} for order #${orderLabel} was returned to the shop owner.`
        );
        return;
    }

    // assign / reassign / auto
    if (fromUserId != null && Number(fromUserId) !== Number(toUserId)) {
        await notifyUser(
            fromUserId,
            'staffJobUnassigned',
            'Job reassigned',
            `Your ${leg} for order #${orderLabel} was reassigned.`
        );
    }
    await notifyUser(
        toUserId,
        'staffJobAssigned',
        'New job assigned',
        `You were assigned ${leg} for order #${orderLabel}.`
    );
}

module.exports = {
    notifyStaffAssignmentChange,
};
