'use strict';

/**
 * Preferred-shop resolution for a returning customer.
 *
 * The shop that last completed an order for this customer gets a private
 * head-start window before the booking is broadcast to the whole zone. If that
 * shop cannot take the job — admin restricted it, it is closed, blocked, or no
 * longer offers the selected services — we walk back through the customer's
 * earlier completed orders instead of jumping straight to a full broadcast.
 *
 * Shared by createBooking and the recurring cycle generator so both paths honour
 * the same eligibility rules.
 */
const { Op } = require('sequelize');
const {
    booking,
    addressDb,
    users,
    agentSelectServices,
    bussinessInformation,
} = require('../models');
const { isShopEligibleForBroadcast } = require('../utils/shopWorkingHours');
const { getCountryContextFromZoneId } = require('../utils/countryTimeZone');
const { isShopSlotFree } = require('../utils/shopSlotAvailability');
const shopAssignmentPolicyService = require('./Admin/shopAssignmentPolicyService');

const COMPLETED_STATUS_ID = 17;

/** How far back through completed orders we look for a usable shop. */
const HISTORY_LOOKBACK_ROWS = 40;
const MAX_CANDIDATE_SHOPS = 10;

const SKIP_REASONS = Object.freeze({
    NO_HISTORY: 'no_history',
    NO_ELIGIBLE_HISTORY: 'no_eligible_history',
    DISABLED: 'preferred_disabled',
    ERROR: 'resolver_error',
    SLOT_TAKEN: 'slot_taken',
});

function normalizeServiceIds(services) {
    return [
        ...new Set(
            (services || [])
                .map((s) => Number(s?.serviceId))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];
}

/**
 * Distinct laundry shop address IDs from this customer's completed orders in
 * this zone, most recent first.
 */
async function getCompletedShopHistory(customerId, zoneId) {
    const rows = await booking.findAll({
        where: {
            customerId,
            zoneId,
            bookingStatusId: COMPLETED_STATUS_ID,
            laundryShopId: { [Op.ne]: null },
        },
        attributes: ['laundryShopId'],
        order: [['updatedAt', 'DESC']],
        limit: HISTORY_LOOKBACK_ROWS,
    });

    const ordered = [];
    const seen = new Set();
    for (const row of rows) {
        const shopId = Number(row.laundryShopId);
        if (!Number.isFinite(shopId) || seen.has(shopId)) continue;
        seen.add(shopId);
        ordered.push(shopId);
        if (ordered.length >= MAX_CANDIDATE_SHOPS) break;
    }
    return ordered;
}

/** Load candidate shops with everything eligibility needs, in one query. */
async function loadCandidateShops(shopAddressIds, zoneId, requiredServiceIds) {
    if (!shopAddressIds.length) return [];

    const rows = await addressDb.findAll({
        where: {
            id: { [Op.in]: shopAddressIds },
            zoneId,
            addressType: 'LaundaryShopAddress',
        },
        attributes: ['id', 'status', 'zoneId', 'userId'],
        include: [
            {
                model: users,
                attributes: ['id', 'firstName', 'lastName', 'email', 'status'],
                required: true,
                include: [
                    {
                        model: agentSelectServices,
                        as: 'agentServices',
                        where: {
                            serviceId: {
                                [Op.in]: requiredServiceIds.length
                                    ? requiredServiceIds
                                    : [0],
                            },
                            status: true,
                        },
                        attributes: ['id', 'serviceId'],
                        required: false,
                    },
                    {
                        model: bussinessInformation,
                        as: 'businessInfo',
                        attributes: ['shopName'],
                        required: false,
                    },
                ],
            },
        ],
    });

    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    return shopAddressIds.map((id) => byId.get(id)).filter(Boolean);
}

function offersAllServices(shop, requiredServiceIds) {
    if (!requiredServiceIds.length) return false;
    const offered = new Set(
        (shop.user?.agentServices || []).map((a) => Number(a.serviceId))
    );
    return requiredServiceIds.every((id) => offered.has(id));
}

/**
 * Pick the preferred shop for a booking.
 *
 * @returns {Promise<{shop: object|null, skipReason: string|null, candidateShopIds: number[]}>}
 */
async function resolvePreferredShop({
    customerId,
    zoneId,
    services,
    collectionDate = null,
    collectionTimeFrom = null,
    collectionTimeTo = null,
    deliveryDate = null,
    deliveryTimeFrom = null,
    deliveryTimeTo = null,
    excludeBookingId = null,
    timeZone = null,
    clientTimeZone = null,
} = {}) {
    const emptyResult = (skipReason) => ({
        shop: null,
        skipReason,
        candidateShopIds: [],
    });

    try {
        if (!customerId || !zoneId) return emptyResult(SKIP_REASONS.NO_HISTORY);

        const requiredServiceIds = normalizeServiceIds(services);
        const history = await getCompletedShopHistory(customerId, zoneId);
        if (!history.length) return emptyResult(SKIP_REASONS.NO_HISTORY);

        const candidates = await loadCandidateShops(
            history,
            zoneId,
            requiredServiceIds
        );
        if (!candidates.length) {
            return {
                shop: null,
                skipReason: SKIP_REASONS.NO_ELIGIBLE_HISTORY,
                candidateShopIds: history,
            };
        }

        const { preferredExcluded } =
            await shopAssignmentPolicyService.getRestrictedShopUserIds();

        const countryCtx = await getCountryContextFromZoneId(zoneId);
        const resolvedTz = timeZone || countryCtx.ianaTimeZone;
        const pickup =
            collectionDate && collectionTimeFrom && collectionTimeTo
                ? { collectionDate, collectionTimeFrom, collectionTimeTo }
                : null;
        const requestedWindow = {
            collectionDate,
            collectionTimeFrom,
            collectionTimeTo,
            deliveryDate,
            deliveryTimeFrom,
            deliveryTimeTo,
        };

        // A shop rejected only because its schedule is full is a different
        // signal from "this customer has no usable history" — keep it so the
        // booking row records why phase 1 was skipped.
        let sawSlotClash = false;

        for (const shop of candidates) {
            const ownerId = Number(shop.user?.id || shop.userId);
            if (!ownerId) continue;

            // Shop address deactivated by admin.
            if (shop.status === false) continue;

            // Account blocked (users.status false) — cannot work the order.
            if (shop.user?.status === false) continue;

            if (!offersAllServices(shop, requiredServiceIds)) continue;

            // Admin took this shop out of preferred routing (or put it on hold).
            if (preferredExcluded.has(ownerId)) continue;

            const openForPickup = await isShopEligibleForBroadcast(
                ownerId,
                countryCtx.countryId,
                resolvedTz,
                clientTimeZone,
                pickup
            );
            if (!openForPickup) continue;

            // Already committed to other work in this pickup/delivery window.
            const slotFree = await isShopSlotFree(shop.id, requestedWindow, {
                excludeBookingId,
            });
            if (!slotFree) {
                sawSlotClash = true;
                continue;
            }

            const { evaluateShopAcceptCapacity } = require('../utils/shopAcceptCapacity');
            const capacity = await evaluateShopAcceptCapacity(ownerId, shop.id, {
                excludeBookingId,
            });
            if (!capacity.allowed) continue;

            return { shop, skipReason: null, candidateShopIds: history };
        }

        return {
            shop: null,
            skipReason: sawSlotClash
                ? SKIP_REASONS.SLOT_TAKEN
                : SKIP_REASONS.NO_ELIGIBLE_HISTORY,
            candidateShopIds: history,
        };
    } catch (err) {
        console.error('[preferredShopResolver] error:', err?.message || err);
        return emptyResult(SKIP_REASONS.ERROR);
    }
}

module.exports = {
    resolvePreferredShop,
    SKIP_REASONS,
    COMPLETED_STATUS_ID,
};
