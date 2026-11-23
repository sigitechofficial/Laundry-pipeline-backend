'use strict';

const { addressDb } = require('../../models');
const { NotFoundError } = require('../../middlewares/universalErrorHandler');

const SHOP_ADDRESS_TYPE = 'LaundaryShopAddress';

/**
 * Zone managers only see and act on shops in their own zone (platform admins:
 * zoneId null = every shop). Unknown or other-zone shop → 404, like a missing id.
 * zoneId is req.scopedZoneId, set by enforceAdminZoneScope for zone staff only.
 * @param {number} agentUserId shop owner user id
 * @param {number|null} zoneId
 */
async function assertAgentInZone(agentUserId, zoneId) {
    if (zoneId == null) return;
    const shop = await addressDb.findOne({
        where: { userId: agentUserId, addressType: SHOP_ADDRESS_TYPE },
        attributes: ['id', 'zoneId'],
    });
    if (!shop || Number(shop.zoneId) !== Number(zoneId)) {
        throw new NotFoundError('Shop not found');
    }
}

/** The admin's forced zone (zone staff), or null for platform admins (every zone). */
function scopedZoneOf(req) {
    return req?.scopedZoneId != null ? Number(req.scopedZoneId) : null;
}

module.exports = {
    SHOP_ADDRESS_TYPE,
    assertAgentInZone,
    scopedZoneOf,
};
