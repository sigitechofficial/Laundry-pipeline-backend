'use strict';

/**
 * The signed-in shop's business information, working hours and platform hours.
 *
 * Routes (routes/agent.js) run validateAccessToken first, so every handler reads the
 * caller's own shop: shopAgentIdFromReq (owner → own id, employee → employeeOff).
 *
 * Legacy `:userId` path param: installed app builds still call
 * `getBussinessInforMation/:userId` and `getBussinessWrkinghours/:userId` with the
 * signed-in user's own id. For an employee that is the employee's id, not the shop's,
 * so refusing a mismatch would break every installed build used by staff. The param
 * is therefore accepted and IGNORED: it never selects whose data is returned, and a
 * caller can only ever read its own shop. Admins read any shop through
 * GET /admin/agents/:agentId/business-information (permission + zone checked).
 */

const ResponseHelper = require('../../utils/responseHelper');
const { UnauthorizedError } = require('../../middlewares/universalErrorHandler');
const { shopAgentIdFromReq } = require('../../utils/shopAgentContext');
const shopBusinessInformationService = require('../../services/Agent/shopBusinessInformationService');

function callerShopId(req) {
    const shopId = shopAgentIdFromReq(req);
    if (shopId == null) {
        // Unreachable behind validateAccessToken; a route wired without it fails closed.
        throw new UnauthorizedError('Sign in to view your shop');
    }
    return shopId;
}

exports.getBusinessInformation = async (req, res) => {
    const data = await shopBusinessInformationService.getBusinessInformation(callerShopId(req));
    return ResponseHelper.success(res, 'Information fetched', data);
};

exports.getWorkingHours = async (req, res) => {
    const data = await shopBusinessInformationService.getWorkingHours(callerShopId(req));
    return ResponseHelper.success(res, 'Information fetched', data);
};

exports.getPlatformOperationalHours = async (req, res) => {
    const data = await shopBusinessInformationService.getPlatformOperationalHours(callerShopId(req));
    return ResponseHelper.success(res, 'Platform operational hours retrieved successfully', data);
};
