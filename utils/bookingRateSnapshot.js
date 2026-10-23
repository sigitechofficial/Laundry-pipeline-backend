/**
 * Zone commercial terms snapshot — same idea as cancellation/no-show policy IDs.
 *
 * - Unaccepted booking: live zone (admin can still change min / fee / commission).
 * - Accepted or admin-assigned: freeze current zone rates write-once.
 * - Invoice, wallet, and admin breakdown must use the freeze, never a later zone edit.
 */

const {
    resolveAgentCommissionPercent,
    clampPercent,
} = require("./agentCommission");

const RATE_SNAPSHOT_ATTRIBUTES = [
    "appliedZoneMinimum",
    "appliedServiceCharge",
    "appliedAgentCommissionPercent",
    "appliedPlatformCommissionPercent",
    "rateSnapshotLockedAt",
    "rateSnapshotSource",
    "revenueRampStep",
    "laundryShopId",
];

const ZONE_COMMERCIAL_ATTRIBUTES = [
    "id",
    "name",
    "zoneMinimumAmount",
    "serviceCharge",
    "zoneAdminComission",
    "agentCommissionPercent",
];

function toPlain(row) {
    if (!row) return null;
    return typeof row.get === "function" ? row.get({ plain: true }) : row;
}

function money(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? parseFloat(n.toFixed(2)) : 0;
}

function isBookingAccepted(bookingPlain) {
    const shopId = bookingPlain?.laundryShopId;
    return shopId != null && shopId !== "";
}

function isRateSnapshotLocked(bookingPlain) {
    return Boolean(bookingPlain?.rateSnapshotLockedAt);
}

function rampStepFrom(bookingPlain) {
    if (bookingPlain?.revenueRampStep == null || bookingPlain.revenueRampStep === "") {
        return null;
    }
    const n = Number(bookingPlain.revenueRampStep);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function isMissingRampColumn(err) {
    const msg = `${err?.message || ""} ${err?.parent?.message || ""} ${err?.original?.message || ""}`;
    return /Unknown column|ER_BAD_FIELD_ERROR|revenueRamp/i.test(msg);
}

function liveZoneTerms(zoneRow) {
    const agentPct = resolveAgentCommissionPercent(zoneRow);
    const platformPct = clampPercent(zoneRow?.zoneAdminComission);
    return {
        zoneMinimumAmount: money(zoneRow?.zoneMinimumAmount),
        serviceCharge: money(zoneRow?.serviceCharge),
        agentCommissionPercent: agentPct,
        platformCommissionPercent:
            platformPct != null ? platformPct : parseFloat((100 - agentPct).toFixed(2)),
    };
}

/**
 * Resolve min / fee / commission for a booking already loaded in memory.
 */
function resolveCommercialTerms(bookingPlain, liveZone) {
    const live = liveZoneTerms(liveZone);
    if (isRateSnapshotLocked(bookingPlain)) {
        const agentPct = clampPercent(bookingPlain.appliedAgentCommissionPercent);
        const platformPct = clampPercent(bookingPlain.appliedPlatformCommissionPercent);
        return {
            locked: true,
            source: bookingPlain.rateSnapshotSource || "accepted",
            lockedAt: bookingPlain.rateSnapshotLockedAt,
            zoneMinimumAmount: money(bookingPlain.appliedZoneMinimum),
            serviceCharge: money(bookingPlain.appliedServiceCharge),
            agentCommissionPercent:
                agentPct != null ? agentPct : live.agentCommissionPercent,
            platformCommissionPercent:
                platformPct != null ? platformPct : live.platformCommissionPercent,
            revenueRampStep: rampStepFrom(bookingPlain),
            live,
        };
    }
    return {
        locked: false,
        source: "live",
        lockedAt: null,
        revenueRampStep: rampStepFrom(bookingPlain),
        ...live,
        live,
    };
}

function toCommercialTermsPayload(terms) {
    const live = terms?.live || null;
    const rampSplit = [1, 2, 3].includes(Number(terms?.revenueRampStep));
    const differsFromLiveZone = Boolean(
        terms?.locked &&
            live &&
            (money(live.zoneMinimumAmount) !== money(terms.zoneMinimumAmount) ||
                money(live.serviceCharge) !== money(terms.serviceCharge) ||
                (!rampSplit &&
                    Number(live.agentCommissionPercent) !==
                        Number(terms.agentCommissionPercent)) ||
                (!rampSplit &&
                    Number(live.platformCommissionPercent) !==
                        Number(terms.platformCommissionPercent)))
    );
    return {
        locked: Boolean(terms?.locked),
        source: terms?.source || "live",
        lockedAt: terms?.lockedAt || null,
        zoneMinimumAmount: money(terms?.zoneMinimumAmount),
        serviceCharge: money(terms?.serviceCharge),
        agentCommissionPercent: Number(terms?.agentCommissionPercent) || 0,
        platformCommissionPercent: Number(terms?.platformCommissionPercent) || 0,
        revenueRampStep: terms?.revenueRampStep ?? null,
        liveZone: terms?.locked ? live : null,
        differsFromLiveZone,
    };
}

function applyTermsToBookingInstance(bookingRow, terms) {
    if (!bookingRow || !terms?.locked || typeof bookingRow.set !== "function") {
        return;
    }
    bookingRow.set({
        appliedZoneMinimum: terms.zoneMinimumAmount,
        appliedServiceCharge: terms.serviceCharge,
        appliedAgentCommissionPercent: terms.agentCommissionPercent,
        appliedPlatformCommissionPercent: terms.platformCommissionPercent,
        rateSnapshotLockedAt: terms.lockedAt,
        rateSnapshotSource: terms.source,
        revenueRampStep: terms.revenueRampStep ?? null,
    });
}

/**
 * Write-once freeze from the current zone row.
 */
async function reloadCommercialTerms(bookingId) {
    const { booking, zone } = require("../models");
    const fresh = await booking.findByPk(bookingId, {
        include: [
            {
                model: zone,
                attributes: ZONE_COMMERCIAL_ATTRIBUTES,
                required: false,
            },
        ],
    });
    if (!fresh) return null;
    return resolveCommercialTerms(toPlain(fresh), fresh.zone);
}

async function lockBookingRateSnapshot(bookingId, { source = "accepted" } = {}) {
    const { booking, zone, sequelize } = require("../models");
    const revenueRampService = require("../services/Admin/revenueRampService");
    const row = await booking.findByPk(bookingId, {
        include: [
            {
                model: zone,
                attributes: ZONE_COMMERCIAL_ATTRIBUTES,
                required: false,
            },
        ],
    });
    if (!row) return null;

    const plain = toPlain(row);
    if (isRateSnapshotLocked(plain)) {
        return resolveCommercialTerms(plain, row.zone);
    }
    if (!row.zone) {
        return resolveCommercialTerms(plain, null);
    }

    const live = liveZoneTerms(row.zone);
    const lockedAt = new Date();
    const basePayload = {
        appliedZoneMinimum: live.zoneMinimumAmount,
        appliedServiceCharge: live.serviceCharge,
        appliedAgentCommissionPercent: live.agentCommissionPercent,
        appliedPlatformCommissionPercent: live.platformCommissionPercent,
        rateSnapshotLockedAt: lockedAt,
        rateSnapshotSource: source,
    };

    try {
        await sequelize.transaction(async (transaction) => {
            const split = await revenueRampService.claimSplit({
                transaction,
                laundryShopId: plain.laundryShopId,
                zoneId: plain.zoneId || row.zone.id,
                live,
            });
            const [affected] = await booking.update(
                {
                    ...basePayload,
                    appliedAgentCommissionPercent: split.agentCommissionPercent,
                    appliedPlatformCommissionPercent: split.platformCommissionPercent,
                    revenueRampStep: split.revenueRampStep,
                },
                {
                    where: { id: bookingId, rateSnapshotLockedAt: null },
                    transaction,
                }
            );
            if (!affected) {
                const race = new Error("snapshot-race");
                race.code = "SNAPSHOT_RACE";
                throw race;
            }
        });
    } catch (err) {
        if (err?.code === "SNAPSHOT_RACE") {
            return reloadCommercialTerms(bookingId);
        }
        if (!isMissingRampColumn(err)) throw err;
        console.warn(
            "[revenueRamp] snapshot written without ramp columns:",
            err?.message || err
        );
        await booking.update(basePayload, {
            where: { id: bookingId, rateSnapshotLockedAt: null },
        });
    }

    return reloadCommercialTerms(bookingId);
}

/**
 * Lock if the shop has already taken the order and no snapshot exists yet.
 */
async function ensureRateSnapshotOnBooking(bookingRow, { source = "accepted" } = {}) {
    const plain = toPlain(bookingRow);
    if (!plain) {
        return resolveCommercialTerms(null, bookingRow?.zone);
    }
    if (isRateSnapshotLocked(plain)) {
        return resolveCommercialTerms(plain, bookingRow.zone);
    }
    if (!isBookingAccepted(plain)) {
        return resolveCommercialTerms(plain, bookingRow.zone);
    }
    const terms = await lockBookingRateSnapshot(plain.id, { source });
    applyTermsToBookingInstance(bookingRow, terms);
    return terms;
}

function attachCommercialTerms(bookingPlain, liveZone) {
    return toCommercialTermsPayload(resolveCommercialTerms(bookingPlain, liveZone));
}

module.exports = {
    RATE_SNAPSHOT_ATTRIBUTES,
    ZONE_COMMERCIAL_ATTRIBUTES,
    toPlain,
    isBookingAccepted,
    isRateSnapshotLocked,
    liveZoneTerms,
    resolveCommercialTerms,
    toCommercialTermsPayload,
    lockBookingRateSnapshot,
    ensureRateSnapshotOnBooking,
    attachCommercialTerms,
};
