'use strict';

/**
 * Admin routing restrictions per shop.
 *
 * Levers (independent of users.status / login block):
 *  - preferredEligible=false → skip preferred head-start; still gets broadcasts
 *  - marketplaceHold=true    → no new offers; admin assign still OK
 *  - acceptCapOverride       → per-shop rolling accept limit (window × max);
 *                              inherits global runtime settings when off
 *
 * expiresAt only heals preferred/hold restrictions — accept capacity override
 * stays until cleared.
 */
const { Op } = require('sequelize');
const { shopAssignmentPolicy, users, addressDb } = require('../../models');
const {
    NotFoundError,
    ValidationError,
} = require('../../middlewares/universalErrorHandler');

const DEFAULT_POLICY = Object.freeze({
    preferredEligible: true,
    marketplaceHold: false,
    reason: null,
    expiresAt: null,
    acceptCapOverride: false,
    acceptWindowMinutes: null,
    acceptMaxOrders: null,
});

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseNullableInt(value, fallback) {
    if (value === undefined) return fallback;
    if (value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.trunc(n);
}

function isExpired(row, now = new Date()) {
    return row?.expiresAt != null && new Date(row.expiresAt).getTime() <= now.getTime();
}

function acceptCapFields(row) {
    if (!row) {
        return {
            acceptCapOverride: false,
            acceptWindowMinutes: null,
            acceptMaxOrders: null,
        };
    }
    return {
        acceptCapOverride: Boolean(row.acceptCapOverride),
        acceptWindowMinutes:
            row.acceptWindowMinutes == null ? null : Number(row.acceptWindowMinutes),
        acceptMaxOrders:
            row.acceptMaxOrders == null ? null : Number(row.acceptMaxOrders),
    };
}

/** Effective policy for a row (or missing row), with expiry applied to hold/preferred. */
function toEffectivePolicy(row, now = new Date()) {
    const cap = acceptCapFields(row);
    if (!row || isExpired(row, now)) {
        return {
            ...DEFAULT_POLICY,
            ...cap,
            ...(row
                ? {
                      reason: row.reason ?? null,
                      expiresAt: row.expiresAt ?? null,
                      expired: true,
                  }
                : { expired: false }),
        };
    }
    return {
        preferredEligible: Boolean(row.preferredEligible),
        marketplaceHold: Boolean(row.marketplaceHold),
        reason: row.reason ?? null,
        expiresAt: row.expiresAt ?? null,
        expired: false,
        ...cap,
    };
}

class ShopAssignmentPolicyService {
    /** Effective policy for one shop owner (never throws for a missing row). */
    async getPolicy(shopUserId) {
        const id = Number(shopUserId);
        if (!Number.isInteger(id) || id <= 0) {
            throw new ValidationError('Valid shopUserId is required');
        }

        const row = await shopAssignmentPolicy.findOne({
            where: { shopUserId: id },
        });

        return { shopUserId: id, ...toEffectivePolicy(row) };
    }

    /**
     * Upsert restrictions for a shop owner.
     * A reason is mandatory whenever preferred/hold is restrictive.
     */
    async setPolicy(shopUserId, payload = {}, adminUserId = null) {
        const id = Number(shopUserId);
        if (!Number.isInteger(id) || id <= 0) {
            throw new ValidationError('Valid shopUserId is required');
        }

        const owner = await users.findOne({
            where: { id },
            attributes: ['id'],
        });
        if (!owner) throw new NotFoundError('Shop owner not found');

        const existing = await shopAssignmentPolicy.findOne({
            where: { shopUserId: id },
        });

        const preferredEligible = parseBoolean(
            payload.preferredEligible,
            existing ? Boolean(existing.preferredEligible) : true
        );
        const marketplaceHold = parseBoolean(
            payload.marketplaceHold,
            existing ? Boolean(existing.marketplaceHold) : false
        );

        const acceptCapOverride = parseBoolean(
            payload.acceptCapOverride,
            existing ? Boolean(existing.acceptCapOverride) : false
        );

        let acceptWindowMinutes = existing?.acceptWindowMinutes ?? null;
        let acceptMaxOrders = existing?.acceptMaxOrders ?? null;
        if (payload.acceptWindowMinutes !== undefined) {
            acceptWindowMinutes = parseNullableInt(
                payload.acceptWindowMinutes,
                acceptWindowMinutes
            );
        }
        if (payload.acceptMaxOrders !== undefined) {
            acceptMaxOrders = parseNullableInt(
                payload.acceptMaxOrders,
                acceptMaxOrders
            );
        }

        if (acceptCapOverride) {
            if (acceptWindowMinutes == null) {
                throw new ValidationError(
                    'Accept window (minutes) is required when using a shop-specific capacity'
                );
            }
            if (acceptWindowMinutes < 1 || acceptWindowMinutes > 1440) {
                throw new ValidationError(
                    'Accept window must be between 1 and 1440 minutes'
                );
            }
            if (acceptMaxOrders == null) {
                throw new ValidationError(
                    'Max accepts is required when using a shop-specific capacity (use 0 for none)'
                );
            }
            if (acceptMaxOrders < 0 || acceptMaxOrders > 500) {
                throw new ValidationError('Max accepts must be between 0 and 500');
            }
        } else {
            acceptWindowMinutes = null;
            acceptMaxOrders = null;
        }

        const restrictive = !preferredEligible || marketplaceHold;
        const reason =
            payload.reason !== undefined
                ? String(payload.reason || '').trim() || null
                : existing?.reason ?? null;

        if (restrictive && !reason) {
            throw new ValidationError(
                'A reason is required when restricting a shop from routing'
            );
        }

        let expiresAt = existing?.expiresAt ?? null;
        if (payload.expiresAt !== undefined) {
            if (payload.expiresAt === null || payload.expiresAt === '') {
                expiresAt = null;
            } else {
                const parsed = new Date(payload.expiresAt);
                if (Number.isNaN(parsed.getTime())) {
                    throw new ValidationError('expiresAt must be a valid date');
                }
                expiresAt = parsed;
            }
        }

        const values = {
            shopUserId: id,
            preferredEligible,
            marketplaceHold,
            reason: restrictive ? reason : null,
            expiresAt: restrictive ? expiresAt : null,
            acceptCapOverride,
            acceptWindowMinutes: acceptCapOverride ? acceptWindowMinutes : null,
            acceptMaxOrders: acceptCapOverride ? acceptMaxOrders : null,
            updatedByUserId: adminUserId ? Number(adminUserId) : null,
        };

        if (existing) {
            await existing.update(values);
        } else {
            await shopAssignmentPolicy.create(values);
        }

        return this.getPolicy(id);
    }

    /**
     * Shop owner IDs currently restricted, for use in assignment queries.
     * @returns {Promise<{preferredExcluded:Set<number>, holdExcluded:Set<number>}>}
     */
    async getRestrictedShopUserIds() {
        const now = new Date();
        const rows = await shopAssignmentPolicy.findAll({
            where: {
                [Op.or]: [{ preferredEligible: false }, { marketplaceHold: true }],
                [Op.and]: [
                    {
                        [Op.or]: [
                            { expiresAt: null },
                            { expiresAt: { [Op.gt]: now } },
                        ],
                    },
                ],
            },
            attributes: ['shopUserId', 'preferredEligible', 'marketplaceHold'],
        });

        const preferredExcluded = new Set();
        const holdExcluded = new Set();

        for (const row of rows) {
            const id = Number(row.shopUserId);
            if (row.marketplaceHold) {
                holdExcluded.add(id);
                preferredExcluded.add(id);
            } else if (!row.preferredEligible) {
                preferredExcluded.add(id);
            }
        }

        return { preferredExcluded, holdExcluded };
    }

    /** Shop owner IDs that must not receive any new offer. */
    async getMarketplaceHoldUserIds() {
        const { holdExcluded } = await this.getRestrictedShopUserIds();
        return [...holdExcluded];
    }

    /** True when this shop owner is currently barred from new offers. */
    async isMarketplaceHeld(shopUserId) {
        const id = Number(shopUserId);
        if (!Number.isInteger(id) || id <= 0) return false;

        const row = await shopAssignmentPolicy.findOne({
            where: { shopUserId: id },
            attributes: [
                'marketplaceHold',
                'preferredEligible',
                'expiresAt',
                'acceptCapOverride',
                'acceptWindowMinutes',
                'acceptMaxOrders',
            ],
        });
        return toEffectivePolicy(row).marketplaceHold;
    }

    /**
     * Resolve the owner user ID behind a laundry shop address, so the admin UI
     * can address the policy by either identifier.
     */
    async resolveShopOwnerIdFromAddress(shopAddressId) {
        const row = await addressDb.findOne({
            where: { id: Number(shopAddressId), addressType: 'LaundaryShopAddress' },
            attributes: ['id', 'userId'],
        });
        return row?.userId ?? null;
    }
}

module.exports = new ShopAssignmentPolicyService();
module.exports.toEffectivePolicy = toEffectivePolicy;
