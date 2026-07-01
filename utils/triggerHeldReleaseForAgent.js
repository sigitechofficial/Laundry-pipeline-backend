const { addressDb } = require('../models');

/**
 * Release queued held bookings for the agent's zone when their shop opens / app connects.
 * @param {number|string} agentUserId
 */
async function triggerHeldReleaseForAgent(agentUserId) {
    if (!agentUserId) return { released: 0 };

    const shop = await addressDb.findOne({
        where: {
            userId: agentUserId,
            addressType: 'LaundaryShopAddress',
        },
        attributes: ['zoneId'],
    });

    if (!shop?.zoneId) return { released: 0 };

    const { releaseHeldBookingsForZone } = require('../services/bookingHeldReleaseService');
    return releaseHeldBookingsForZone(shop.zoneId);
}

module.exports = { triggerHeldReleaseForAgent };
