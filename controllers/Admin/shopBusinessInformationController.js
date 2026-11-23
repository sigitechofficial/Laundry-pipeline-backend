'use strict';

/**
 * Admin view of any shop's business information (machine catalog + the services
 * the shop offers), the admin counterpart of the agent app's
 * GET /agent/getBussinessInforMation, which only ever serves the caller's own shop.
 *
 * GET /admin/agents/:agentId/business-information (:agentId = shop owner user id)
 * Guarded in routes/admin.js by router.use(adminValidateToken, checkPermission,
 * enforceAdminZoneScope): `/agents` maps to the shopManagement feature (read), and
 * zone staff may only open shops in their own zone (other zone → 404).
 */

const ResponseHelper = require('../../utils/responseHelper');
const { users } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { assertAgentInZone, scopedZoneOf } = require('../../services/Admin/adminShopZoneScope');
const shopBusinessInformationService = require('../../services/Agent/shopBusinessInformationService');

const SHOP_OWNER_USER_TYPE_ID = 4;

function parseAgentId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('agentId must be a positive integer');
    }
    return id;
}

/** A shop owner account: agent user type, not a shop or admin employee. */
async function assertShopOwner(agentId) {
    const owner = await users.findByPk(agentId, {
        attributes: ['id', 'userTypeId', 'classifiedAsId'],
    });
    const isOwner =
        owner &&
        Number(owner.userTypeId) === SHOP_OWNER_USER_TYPE_ID &&
        owner.classifiedAsId == null;
    if (!isOwner) {
        throw new NotFoundError('Shop not found');
    }
}

exports.getShopBusinessInformation = async (req, res) => {
    const agentId = parseAgentId(req.params.agentId);
    await assertShopOwner(agentId);
    await assertAgentInZone(agentId, scopedZoneOf(req));
    const data = await shopBusinessInformationService.getBusinessInformation(agentId);
    return ResponseHelper.success(res, 'Information fetched', data);
};
