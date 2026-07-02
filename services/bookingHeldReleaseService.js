const { Op } = require("sequelize");
const {
    booking,
    customerSelectedService,
} = require("../models");
const { isAnyShopOpenInZone, isPlatformOpenNow } = require("../utils/shopWorkingHours");
const {
    getOrderExpireTime,
} = require("../utils/bookingTimeZone");
const { getCountryContextFromZoneId } = require("../utils/countryTimeZone");
const { isAnyAgentOnlineInZone } = require("../utils/agentOnlineStatus");

const HELD_RELEASE_INTERVAL_MS = 5 * 60 * 1000;
let releaseTimer = null;

async function canReleaseHeldBooking(row, countryCtx) {
    if (row.placedOutsidePlatformHours) {
        return isAnyAgentOnlineInZone(row.zoneId);
    }

    const platformOpen = await isPlatformOpenNow(
        countryCtx.countryId,
        countryCtx.ianaTimeZone
    );
    if (!platformOpen) {
        return isAnyAgentOnlineInZone(row.zoneId);
    }

    return isAnyShopOpenInZone(row.zoneId, countryCtx.ianaTimeZone);
}

async function releaseSingleHeldBooking(row) {
    const countryCtx = await getCountryContextFromZoneId(row.zoneId);
    const canRelease = await canReleaseHeldBooking(row, countryCtx);
    if (!canRelease) return false;

    const services = await customerSelectedService.findAll({
        where: { bookingId: row.id },
        attributes: ["serviceId"],
    });
    const servicePayload = services.map((s) => ({
        serviceId: s.serviceId,
    }));

    const visibleAt = new Date();
    const updatePayload = {
        agentBroadcastHeld: false,
        agentVisibleAt: visibleAt,
    };

    if (!row.placedOutsidePlatformHours) {
        updatePayload.orderExpireTime = getOrderExpireTime(
            countryCtx.ianaTimeZone
        );
    }

    await booking.update(updatePayload, { where: { id: row.id } });

    const { bookingEventSentCheckTheShops } = require("./Customer/customerOrderService");
    const { notifiedCount } = await bookingEventSentCheckTheShops(
        row.id,
        row.zoneId,
        row.collectionDate,
        row.collectionTimeTo,
        row.collectionTimeFrom,
        row.deliveryDate,
        row.deliveryTimeTo,
        row.deliveryTimeFrom,
        servicePayload,
        countryCtx.ianaTimeZone
    );

    if (notifiedCount === 0) {
        const rollbackPayload = {
            agentBroadcastHeld: true,
            agentVisibleAt: null,
        };
        if (!row.placedOutsidePlatformHours) {
            rollbackPayload.orderExpireTime = null;
        }
        await booking.update(rollbackPayload, { where: { id: row.id } });
        return false;
    }

    console.log(
        `[releaseHeldBookings] booking ${row.id} released to agents at ${visibleAt.toISOString()}`
    );
    return true;
}

const HELD_BOOKING_ATTRIBUTES = [
    "id",
    "zoneId",
    "collectionDate",
    "collectionTimeFrom",
    "collectionTimeTo",
    "deliveryDate",
    "deliveryTimeFrom",
    "deliveryTimeTo",
    "placedOutsidePlatformHours",
];

/**
 * Notify agents for bookings queued overnight (agentBroadcastHeld).
 */
async function releaseHeldBookings() {
    const heldBookings = await booking.findAll({
        where: {
            agentBroadcastHeld: true,
            bookingStatusId: 1,
            laundryShopId: null,
        },
        attributes: HELD_BOOKING_ATTRIBUTES,
    });

    if (!heldBookings.length) return { released: 0 };

    let released = 0;
    for (const row of heldBookings) {
        const ok = await releaseSingleHeldBooking(row);
        if (ok) released += 1;
    }

    return { released };
}

/**
 * Release held bookings for one zone immediately (e.g. when an agent shop opens).
 * @param {number|string} zoneId
 */
async function releaseHeldBookingsForZone(zoneId) {
    if (zoneId == null || zoneId === "") return { released: 0 };

    const heldBookings = await booking.findAll({
        where: {
            agentBroadcastHeld: true,
            bookingStatusId: 1,
            laundryShopId: null,
            zoneId,
        },
        attributes: HELD_BOOKING_ATTRIBUTES,
    });

    if (!heldBookings.length) return { released: 0 };

    let released = 0;
    for (const row of heldBookings) {
        const ok = await releaseSingleHeldBooking(row);
        if (ok) released += 1;
    }

    if (released > 0) {
        console.log(
            `[releaseHeldBookingsForZone] zone ${zoneId}: released ${released} held booking(s)`
        );
    }

    return { released };
}

function startHeldBookingReleaseJob() {
    if (releaseTimer) return;

    const run = () => {
        releaseHeldBookings().catch((err) => {
            console.error("[releaseHeldBookings] job error:", err.message);
        });
    };

    run();
    releaseTimer = setInterval(run, HELD_RELEASE_INTERVAL_MS);
    console.log(
        `[releaseHeldBookings] scheduled every ${HELD_RELEASE_INTERVAL_MS / 60000} minutes`
    );
}

module.exports = {
    releaseHeldBookings,
    releaseHeldBookingsForZone,
    startHeldBookingReleaseJob,
};
