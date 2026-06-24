const { addressDb } = require('../models');

function getSendEvent() {
    return require('../socket_io').sendEvent;
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
            shops.map((shop) => shop.userId).filter((id) => id != null && id !== '')
        ),
    ];
}

/**
 * Notify assigned agent (AcceptedOrder) and all other zone shop owners
 * (orderTakenByOtherAgent) so pending lists update without reload.
 *
 * @param {object} params
 * @param {number} params.bookingId
 * @param {number} params.zoneId
 * @param {number} params.assignedUserId - shop owner user id
 * @param {'agent'|'admin'} [params.source]
 */
async function notifyBookingTakenByAgent({
    bookingId,
    zoneId,
    assignedUserId,
    source = 'agent',
    excludeUserIds = [],
}) {
    const ownerIds = await getZoneShopOwnerIds(zoneId);
    if (!ownerIds.length) return;

    const excluded = new Set(
        excludeUserIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id))
    );

    const assignedMessage =
        source === 'admin'
            ? 'Order assigned to your shop by admin'
            : 'Order accepted successfully';

    const othersMessage =
        source === 'admin'
            ? 'This order was assigned by admin to another shop'
            : 'This order was accepted by another agent';

    const numericBookingId = Number(bookingId);
    const numericAssignedId = Number(assignedUserId);

    const sendEvent = getSendEvent();

    await Promise.all(
        ownerIds.map((userId) => {
            if (excluded.has(Number(userId))) {
                return Promise.resolve();
            }

            if (Number(userId) === numericAssignedId) {
                return sendEvent(userId, {
                    type: 'AcceptedOrder',
                    data: {
                        data: numericBookingId,
                        message: assignedMessage,
                    },
                });
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
