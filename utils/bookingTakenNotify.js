const { addressDb } = require('../models');

function getSendEvent() {
    return require('../socket_io').sendEvent;
}

function toFiniteUserId(value) {
    const id = Number(value);
    return Number.isFinite(id) ? id : null;
}

async function getZoneShopOwnerIds(zoneId) {
    if (!zoneId) return [];

    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: 'LaundaryShopAddress',
        },
        attributes: ['userId'],
    });

    return [
        ...new Set(
            shops
                .map((shop) => toFiniteUserId(shop.userId))
                .filter((id) => id != null)
        ),
    ];
}

/**
 * Notify assigned agent (AcceptedOrder) and all other zone shop owners
 * (orderTakenByOtherAgent) so pending lists update without reload.
 *
 * The accepting / newly assigned agent NEVER receives orderTakenByOtherAgent.
 *
 * @param {object} params
 * @param {number} params.bookingId
 * @param {number} params.zoneId
 * @param {number} params.assignedUserId - shop owner (or accepting agent) user id
 * @param {'agent'|'admin'} [params.source]
 * @param {number[]} [params.excludeUserIds] - also skip (e.g. previous owner on reassign)
 */
async function notifyBookingTakenByAgent({
    bookingId,
    zoneId,
    assignedUserId,
    source = 'agent',
    excludeUserIds = [],
}) {
    const numericBookingId = toFiniteUserId(bookingId);
    const numericAssignedId = toFiniteUserId(assignedUserId);

    if (numericBookingId == null) {
        console.warn(
            '[notifyBookingTakenByAgent] skipped — invalid bookingId:',
            bookingId
        );
        return;
    }

    const assignedMessage =
        source === 'admin'
            ? 'Order assigned to your shop by admin'
            : 'Order accepted successfully';

    const othersMessage =
        source === 'admin'
            ? 'This order was assigned by admin to another shop'
            : 'This order was accepted by another agent';

    const sendEvent = getSendEvent();

    // Always exclude the assigned/accepting agent from "taken by other" broadcasts.
    const skipOtherAgentNotify = new Set(
        [...excludeUserIds, assignedUserId]
            .map((id) => toFiniteUserId(id))
            .filter((id) => id != null)
    );

    // 1) Assigned agent: AcceptedOrder only (never orderTakenByOtherAgent).
    if (numericAssignedId != null) {
        await sendEvent(numericAssignedId, {
            type: 'AcceptedOrder',
            data: {
                data: numericBookingId,
                message: assignedMessage,
            },
        });
    } else {
        console.warn(
            '[notifyBookingTakenByAgent] missing assignedUserId — only notifying other shops',
            { bookingId, zoneId, source }
        );
    }

    // 2) Other zone shop owners only.
    const ownerIds = await getZoneShopOwnerIds(zoneId);
    await Promise.all(
        ownerIds.map((userId) => {
            if (skipOtherAgentNotify.has(userId)) {
                return Promise.resolve();
            }

            return sendEvent(userId, {
                type: 'orderTakenByOtherAgent',
                data: {
                    bookingId: numericBookingId,
                    message: othersMessage,
                },
            });
        })
    );
}

module.exports = {
    getZoneShopOwnerIds,
    notifyBookingTakenByAgent,
};
