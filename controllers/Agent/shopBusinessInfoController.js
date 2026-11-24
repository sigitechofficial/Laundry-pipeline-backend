'use strict';

/**
 * The signed-in shop's business information, working hours and platform hours.
 *
 * A signed-in caller always reads its own shop: shopAgentIdFromReq (owner → own id,
 * employee → employeeOff).
 *
 * Legacy `:userId` path param: installed app builds call
 * `getBussinessInforMation/:userId` and `getBussinessWrkinghours/:userId` with the
 * signed-in user's own id. For an employee that is the employee's id, not the shop's,
 * so refusing a mismatch would break every installed build used by staff. For a
 * signed-in caller the param is therefore IGNORED: a session can only read its own
 * shop.
 *
 * PENDING onboarding session: these two reads are also called during shop
 * registration, where installed builds have no session (the login "business
 * information missing" path issues none). Their routes run accessTokenIfPresent, and
 * a request with no token is served the shop named by `:userId`, as before this
 * change. When registration gets a session and the app sends it, both routes move
 * to validateAccessToken and `anonymousLegacyShopId` is deleted.
 * platformOperationalHours always requires a session. Admins read any shop through
 * GET /admin/agents/:agentId/business-information (permission + zone checked).
 */

const ResponseHelper = require('../../utils/responseHelper');
const { UnauthorizedError, ValidationError } = require('../../middlewares/universalErrorHandler');
const { shopAgentIdFromReq } = require('../../utils/shopAgentContext');
const shopBusinessInformationService = require('../../services/Agent/shopBusinessInformationService');

function callerShopId(req) {
    const shopId = shopAgentIdFromReq(req);
    if (shopId == null) {
        // A req.user without a shop (or a route wired without a session) fails closed.
        throw new UnauthorizedError('Sign in to view your shop');
    }
    return shopId;
}

/** PENDING onboarding session: the shop a request without a session asks for. */
function anonymousLegacyShopId(req) {
    const id = Number(req.params && req.params.userId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('userId must be a positive integer');
    }
    return id;
}

/** Signed in: the caller's own shop. No session: the legacy `:userId` (see above). */
function shopIdForRegistrationRead(req) {
    return req.user ? callerShopId(req) : anonymousLegacyShopId(req);
}

exports.getBusinessInformation = async (req, res) => {
    const data = await shopBusinessInformationService.getBusinessInformation(shopIdForRegistrationRead(req));
    return ResponseHelper.success(res, 'Information fetched', data);
};

exports.getWorkingHours = async (req, res) => {
    const data = await shopBusinessInformationService.getWorkingHours(shopIdForRegistrationRead(req));
    return ResponseHelper.success(res, 'Information fetched', data);
};

exports.getPlatformOperationalHours = async (req, res) => {
    const data = await shopBusinessInformationService.getPlatformOperationalHours(callerShopId(req));
    return ResponseHelper.success(res, 'Platform operational hours retrieved successfully', data);
};
