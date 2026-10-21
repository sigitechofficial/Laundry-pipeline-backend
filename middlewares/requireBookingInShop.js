'use strict';

const { NotFoundError } = require('./universalErrorHandler');
const { resolveShopAgentId } = require('../utils/shopAgentContext');

/**
 * Agent routes keyed by :bookingId — continue only when the booking belongs to
 * the caller's shop: booking.laundryShopId → addressDb.userId must equal the
 * caller's shop owner id (staff resolve to their owner via employeeOff).
 *
 * Anything else is 404 "Booking not found" — same as a missing id, so other
 * shops' booking ids cannot be probed.
 *
 * Agent router only, after validateAccessToken. Admin routes that reuse the
 * same controller (e.g. /admin/printLabelData) go through adminValidateToken +
 * checkPermission and must not be shop-gated.
 */

const defaultDeps = {
    async loadBooking(bookingId) {
        const { booking } = require('../models');
        return booking.findByPk(bookingId, { attributes: ['id', 'laundryShopId'] });
    },
    async resolveShopOwnerUserId(laundryShopId) {
        const { resolveShopOwnerUserId } = require('../services/Agent/agentWalletService');
        return resolveShopOwnerUserId(laundryShopId);
    },
};

function isSameShopOwner(shopOwnerUserId, callerShopAgentId) {
    if (shopOwnerUserId == null || callerShopAgentId == null) return false;
    const owner = Number(shopOwnerUserId);
    const caller = Number(callerShopAgentId);
    return Number.isFinite(owner) && owner > 0 && owner === caller;
}

function createRequireBookingInShop(overrides = {}) {
    const deps = { ...defaultDeps, ...overrides };

    return async function requireBookingInShop(req, res, next) {
        try {
            const shopAgentId = req.shopAgentId ?? resolveShopAgentId(req.user);
            const bookingId = req.params?.bookingId;
            if (shopAgentId == null || !bookingId) {
                return next(new NotFoundError('Booking not found'));
            }

            const row = await deps.loadBooking(bookingId);
            const shopOwnerUserId = row?.laundryShopId
                ? await deps.resolveShopOwnerUserId(row.laundryShopId)
                : null;

            if (!isSameShopOwner(shopOwnerUserId, shopAgentId)) {
                return next(new NotFoundError('Booking not found'));
            }
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

const requireBookingInShop = createRequireBookingInShop();
requireBookingInShop.create = createRequireBookingInShop;
requireBookingInShop.isSameShopOwner = isSameShopOwner;

module.exports = requireBookingInShop;
