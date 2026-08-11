const { ForbiddenError } = require('./universalErrorHandler');
const {
    hasShopCapability,
    canManageShopOps,
    canManageShopFinance,
    attachShopAgentContext,
    SHOP_CAPABILITY_KEYS,
} = require('../utils/shopAgentContext');

/**
 * Require a specific shop capability (see getShopCapabilities).
 * Must run after validateAccessToken.
 */
function requireCapability(capability) {
    if (!SHOP_CAPABILITY_KEYS.includes(capability)) {
        throw new Error(`Unknown shop capability: ${capability}`);
    }
    return function requireCapabilityMiddleware(req, res, next) {
        attachShopAgentContext(req);
        if (!hasShopCapability(req.user, capability)) {
            return next(
                new ForbiddenError(
                    `You do not have permission to perform this action (${capability})`
                )
            );
        }
        return next();
    };
}

/**
 * Owner or Laundry Shop Manager — team ops, assign/unassign, accept orders.
 * Must run after validateAccessToken.
 */
function requireShopManagerOrOwner(req, res, next) {
    attachShopAgentContext(req);
    if (!canManageShopOps(req.user)) {
        return next(
            new ForbiddenError(
                'Only the shop owner or manager can perform this action'
            )
        );
    }
    return next();
}

/**
 * Shop owner only — wallet, settlement, bank-level actions.
 */
function requireShopOwner(req, res, next) {
    attachShopAgentContext(req);
    if (!canManageShopFinance(req.user)) {
        return next(
            new ForbiddenError(
                'Only the shop owner can perform this action'
            )
        );
    }
    return next();
}

module.exports = requireShopOwner;
module.exports.requireShopOwner = requireShopOwner;
module.exports.requireShopManagerOrOwner = requireShopManagerOrOwner;
module.exports.requireCapability = requireCapability;
