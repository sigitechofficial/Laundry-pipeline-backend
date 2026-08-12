const { ForbiddenError, NotFoundError } = require('./universalErrorHandler');
const {
    hasShopCapability,
    canManageShopFinance,
    attachShopAgentContext,
    attachEffectiveShopAgentContext,
    isShopOwner,
    isShopManager,
    SHOP_CAPABILITY_KEYS,
} = require('../utils/shopAgentContext');

/**
 * Require a specific shop capability (role ⊕ overrides).
 * Must run after validateAccessToken.
 */
function requireCapability(capability) {
    if (!SHOP_CAPABILITY_KEYS.includes(capability)) {
        throw new Error(`Unknown shop capability: ${capability}`);
    }
    return async function requireCapabilityMiddleware(req, res, next) {
        try {
            await attachEffectiveShopAgentContext(req);
            if (!hasShopCapability(req.user, capability, req.capabilities)) {
                return next(
                    new ForbiddenError(
                        `You do not have permission to perform this action (${capability})`
                    )
                );
            }
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

/**
 * Require at least one of the listed capabilities (role ⊕ overrides).
 */
function requireAnyCapability(capabilities) {
    const keys = Array.isArray(capabilities) ? capabilities : [capabilities];
    for (const key of keys) {
        if (!SHOP_CAPABILITY_KEYS.includes(key)) {
            throw new Error(`Unknown shop capability: ${key}`);
        }
    }
    return async function requireAnyCapabilityMiddleware(req, res, next) {
        try {
            await attachEffectiveShopAgentContext(req);
            const ok = keys.some((key) =>
                hasShopCapability(req.user, key, req.capabilities)
            );
            if (!ok) {
                return next(
                    new ForbiddenError(
                        `You do not have permission to perform this action (${keys.join(' | ')})`
                    )
                );
            }
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

/**
 * Gate trip-progress mutations to the assigned driver (or owner/manager with view/assign).
 * @param {{ types?: Array<'pickup'|'delivery'|'either'> }} options
 */
function requireBookingAssignee({ types = ['either'] } = {}) {
    const typeList = (Array.isArray(types) ? types : [types]).map((t) =>
        String(t || 'either').toLowerCase()
    );

    return async function requireBookingAssigneeMiddleware(req, res, next) {
        try {
            await attachEffectiveShopAgentContext(req);
            const caps = req.capabilities || {};

            const wantsPickup =
                typeList.includes('pickup') || typeList.includes('either');
            const wantsDelivery =
                typeList.includes('delivery') || typeList.includes('either');

            let canRun = false;
            if (typeList.includes('either')) {
                canRun = caps.canRunAssignedJobs === true;
            } else if (wantsPickup && wantsDelivery) {
                canRun =
                    caps.canRunAssignedJobs === true ||
                    caps.canRunAssignedPickup === true ||
                    caps.canRunAssignedDelivery === true;
            } else if (wantsPickup) {
                canRun =
                    caps.canRunAssignedPickup === true ||
                    caps.canRunAssignedJobs === true;
            } else if (wantsDelivery) {
                canRun =
                    caps.canRunAssignedDelivery === true ||
                    caps.canRunAssignedJobs === true;
            }

            if (!canRun) {
                return next(
                    new ForbiddenError(
                        'You do not have permission to run assigned pickup/delivery jobs'
                    )
                );
            }

            const bookingId =
                req.params?.bookingId ??
                req.body?.bookingId ??
                req.query?.bookingId;
            if (!bookingId) {
                return next(new ForbiddenError('bookingId is required'));
            }

            const { booking } = require('../models');
            const row = await booking.findByPk(bookingId, {
                attributes: ['id', 'driverId', 'deliveryDriverId', 'laundryShopId'],
            });
            if (!row) {
                return next(new NotFoundError('Booking not found'));
            }

            const canBypassAssignee =
                (req.isShopOwner || req.isShopManager) &&
                (caps.canViewShopOrders === true || caps.canAssignStaff === true);

            if (canBypassAssignee) {
                req.bookingAssigneeContext = { booking: row, bypassed: true };
                return next();
            }

            const actorId = Number(req.actorUserId);
            const shopAgentId = Number(req.shopAgentId);
            const pickupId =
                row.driverId != null ? Number(row.driverId) : null;
            const deliveryId =
                row.deliveryDriverId != null
                    ? Number(row.deliveryDriverId)
                    : null;
            const deliveryShopHeld =
                deliveryId == null ||
                (Number.isFinite(shopAgentId) && deliveryId === shopAgentId);
            const pickupShopHeld =
                pickupId == null ||
                (Number.isFinite(shopAgentId) && pickupId === shopAgentId);

            let isAssignee = false;
            if (typeList.includes('either')) {
                isAssignee =
                    (pickupId != null && pickupId === actorId) ||
                    (deliveryId != null && deliveryId === actorId);
            } else {
                if (typeList.includes('pickup') && pickupId === actorId) {
                    isAssignee = true;
                }
                if (typeList.includes('delivery') && deliveryId === actorId) {
                    isAssignee = true;
                }
                // Delivery still shop-held: pickup assignee may start OFD / run delivery
                // (same person often continues from facility to customer).
                if (
                    typeList.includes('delivery') &&
                    deliveryShopHeld &&
                    pickupId != null &&
                    pickupId === actorId &&
                    !pickupShopHeld
                ) {
                    isAssignee = true;
                }
            }

            if (!isAssignee) {
                return next(
                    new ForbiddenError(
                        deliveryShopHeld && typeList.includes('delivery')
                            ? 'Delivery is still with the shop owner. Ask them to Assign you on Delivery, or assign yourself if you have permission.'
                            : 'You are not assigned to this booking for this action'
                    )
                );
            }

            req.bookingAssigneeContext = {
                booking: row,
                bypassed: false,
                deliveryShopHeld,
                claimingDeliveryFromPickup:
                    typeList.includes('delivery') &&
                    deliveryShopHeld &&
                    pickupId === actorId,
            };
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

/**
 * Owner or Laundry Shop Manager — team ops, assign/unassign, accept orders.
 * Role-based (not canManageShopOps — managers have shopOps edit = false).
 * Must run after validateAccessToken.
 */
function requireShopManagerOrOwner(req, res, next) {
    attachShopAgentContext(req);
    if (!isShopOwner(req.user) && !isShopManager(req.user)) {
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
module.exports.requireAnyCapability = requireAnyCapability;
module.exports.requireBookingAssignee = requireBookingAssignee;
