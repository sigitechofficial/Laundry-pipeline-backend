'use strict';

/**
 * Admin routing restrictions per shop.
 *
 * Two independent levers, deliberately not folded into users.status:
 *  - preferredEligible=false → skip this shop when picking the returning
 *    customer's preferred shop. It can still receive broadcast bookings.
 *  - marketplaceHold=true    → send no new offers at all. Admin can still
 *    assign manually, and orders already accepted continue normally.
 *
 * A row with expiresAt in the past is treated as unrestricted, so temporary
 * suspensions heal themselves without a cron.
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

function isExpired(row, now = new Date()) {
    return row?.expiresAt != null && new Date(row.expiresAt).getTime() <= now.getTime();
}

/** Effective policy for a row (or missing row), with expiry applied. */
function toEffectivePolicy(row, now = new Date()) {
    if (!row || isExpired(row, now)) {
        return {
            ...DEFAULT_POLICY,
            ...(row
                ? {
                      reason: row.reason ?? null,
                      expiresAt: row.expiresAt ?? null,
                      expired: true,
                  }
                : {}),
        };
    }
    return {
        preferredEligible: Boolean(row.preferredEligible),
        marketplaceHold: Boolean(row.marketplaceHold),
        reason: row.reason ?? null,
        expiresAt: row.expiresAt ?? null,
        expired: false,
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
     * A reason is mandatory whenever either lever is restrictive, so the audit
     * trail explains why a shop stopped receiving work.
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
            attributes: ['marketplaceHold', 'preferredEligible', 'expiresAt'],
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
