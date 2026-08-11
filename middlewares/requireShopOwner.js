const { ForbiddenError } = require('./universalErrorHandler');
const {
    canManageShopOps,
    canManageShopFinance,
    attachShopAgentContext,
} = require('../utils/shopAgentContext');

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
