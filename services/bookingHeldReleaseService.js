const { Op } = require("sequelize");
const {
    booking,
    customerSelectedService,
} = require("../models");
const { isAnyShopOpenInZone } = require("../utils/shopWorkingHours");
const {
    getOrderExpireTime,
} = require("../utils/bookingTimeZone");
const { getCountryContextFromZoneId } = require("../utils/countryTimeZone");

const HELD_RELEASE_INTERVAL_MS = 5 * 60 * 1000;
let releaseTimer = null;

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
        attributes: [
            "id",
            "zoneId",
            "collectionDate",
            "collectionTimeFrom",
            "collectionTimeTo",
            "deliveryDate",
            "deliveryTimeFrom",
            "deliveryTimeTo",
        ],
    });

    if (!heldBookings.length) return { released: 0 };

    const { bookingEventSentCheckTheShops } = require("./Customer/customerOrderService");
    let released = 0;

    for (const row of heldBookings) {
        const countryCtx = await getCountryContextFromZoneId(row.zoneId);
        const zoneOpen = await isAnyShopOpenInZone(
            row.zoneId,
            countryCtx.ianaTimeZone
        );
        if (!zoneOpen) continue;

        const services = await customerSelectedService.findAll({
            where: { bookingId: row.id },
            attributes: ["serviceId"],
        });
        const servicePayload = services.map((s) => ({
            serviceId: s.serviceId,
        }));

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
            continue;
        }

        const visibleAt = new Date();
        await booking.update(
            {
                agentBroadcastHeld: false,
                agentVisibleAt: visibleAt,
                orderExpireTime: getOrderExpireTime(countryCtx.ianaTimeZone),
            },
            { where: { id: row.id } }
        );

        released += 1;
        console.log(
            `[releaseHeldBookings] booking ${row.id} released to agents at ${visibleAt.toISOString()}`
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
    startHeldBookingReleaseJob,
};
