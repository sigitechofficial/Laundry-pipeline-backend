const moment = require("moment-timezone");
const {
    addressDb,
    bussinessWorkingHours,
    bussinessInformation,
    platformOperationalHours,
} = require("../models");
const { resolveBookingTimeZone } = require("./bookingTimeZone");
const {
    getCountryContextById,
    getCountryContextFromZoneId,
    getCountryContextFromShopUserId,
} = require("./countryTimeZone");
const { isAgentOnline } = require("./agentOnlineStatus");

const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

function normalizeTimeString(timeValue) {
    if (!timeValue) return null;
    const raw = String(timeValue).trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
    return null;
}

/**
 * Wall clock from explicit IANA zone (agent query override).
 */
function getWallClockContext(timeZone, clientTimeZone) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    const now = moment.tz(tz);
    return {
        tz,
        now,
        dayOfWeek: DAY_NAMES[now.day()],
        nowTime: now.format("HH:mm:ss"),
        date: now.format("YYYY-MM-DD"),
    };
}

/**
 * @param {number} countryId
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 */
async function getWallClockContextForCountry(countryId, timeZone, clientTimeZone) {
    const countryCtx = await getCountryContextById(countryId);
    const tz = resolveBookingTimeZone(
        timeZone || countryCtx.ianaTimeZone,
        clientTimeZone
    );
    const now = moment.tz(tz);
    return {
        countryId: countryCtx.countryId,
        tz,
        now,
        dayOfWeek: DAY_NAMES[now.day()],
        nowTime: now.format("HH:mm:ss"),
        date: now.format("YYYY-MM-DD"),
    };
}

/**
 * Resolve today's hours row for a shop owner (userId on hours, or shopAddressId → business).
 */
async function findTodayWorkingHoursRow(shopUserId, dayOfWeek) {
    let hoursRow = await bussinessWorkingHours.findOne({
        where: { userId: shopUserId, dayOfWeek },
        attributes: ["openTime", "closeTime", "status", "dayOfWeek"],
    });

    if (!hoursRow) {
        const shopAddress = await addressDb.findOne({
            where: {
                userId: shopUserId,
                addressType: "LaundaryShopAddress",
            },
            attributes: ["id"],
        });

        if (shopAddress?.id) {
            const biz = await bussinessInformation.findOne({
                where: { shopAddressId: shopAddress.id },
                attributes: ["id"],
            });
            if (biz?.id) {
                hoursRow = await bussinessWorkingHours.findOne({
                    where: { bussinessInformationId: biz.id, dayOfWeek },
                    attributes: ["openTime", "closeTime", "status", "dayOfWeek"],
                });
            }
        }
    }

    return hoursRow;
}

async function findTodayPlatformHoursRow(dayOfWeek, countryId) {
    return platformOperationalHours.findOne({
        where: { dayOfWeek, countryId },
        attributes: ["openTime", "closeTime", "status", "dayOfWeek", "countryId"],
    });
}

function isNowWithinHoursWindow(now, date, tz, openTime, closeTime) {
    const openStr = normalizeTimeString(openTime);
    const closeStr = normalizeTimeString(closeTime);
    if (!openStr || !closeStr) return false;

    const openAt = moment.tz(`${date} ${openStr}`, "YYYY-MM-DD HH:mm:ss", tz);
    const closeAt = moment.tz(`${date} ${closeStr}`, "YYYY-MM-DD HH:mm:ss", tz);
    if (!openAt.isValid() || !closeAt.isValid()) return false;

    return now.isSameOrAfter(openAt) && now.isBefore(closeAt);
}

/**
 * Pickup slot must fit entirely inside shop open/close on collection day.
 */
function isTimeSlotWithinHoursWindow(
    dateStr,
    timeFrom,
    timeTo,
    tz,
    openTime,
    closeTime
) {
    const fromStr = normalizeTimeString(timeFrom);
    const toStr = normalizeTimeString(timeTo);
    const openStr = normalizeTimeString(openTime);
    const closeStr = normalizeTimeString(closeTime);
    if (!fromStr || !toStr || !openStr || !closeStr) return false;

    const slotFrom = moment.tz(
        `${dateStr} ${fromStr}`,
        "YYYY-MM-DD HH:mm:ss",
        tz
    );
    const slotTo = moment.tz(`${dateStr} ${toStr}`, "YYYY-MM-DD HH:mm:ss", tz);
    const openAt = moment.tz(`${dateStr} ${openStr}`, "YYYY-MM-DD HH:mm:ss", tz);
    const closeAt = moment.tz(
        `${dateStr} ${closeStr}`,
        "YYYY-MM-DD HH:mm:ss",
        tz
    );

    if (!slotFrom.isValid() || !slotTo.isValid() || !openAt.isValid() || !closeAt.isValid()) {
        return false;
    }
    if (!slotTo.isAfter(slotFrom)) return false;

    return slotFrom.isSameOrAfter(openAt) && slotTo.isSameOrBefore(closeAt);
}

function resolvePickupDayContext(collectionDate, timeZone, clientTimeZone) {
    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    const pickupDay = moment.tz(collectionDate, tz);
    return {
        tz,
        dateStr: pickupDay.format("YYYY-MM-DD"),
        dayOfWeek: DAY_NAMES[pickupDay.day()],
    };
}

/**
 * Whether the booking pickup window fits inside the shop's working hours
 * on the pickup day (collectionDate — not the day the customer booked).
 * Day off on pickup day (status: false) → agent does not receive the booking.
 */
async function isPickupWithinShopWorkingHours(
    shopUserId,
    collectionDate,
    collectionTimeFrom,
    collectionTimeTo,
    timeZone,
    clientTimeZone,
    countryId
) {
    if (!shopUserId || collectionDate == null || !collectionTimeFrom || !collectionTimeTo) {
        return false;
    }

    const { tz, dateStr, dayOfWeek } = resolvePickupDayContext(
        collectionDate,
        timeZone,
        clientTimeZone
    );

    const hoursRow = await findTodayWorkingHoursRow(shopUserId, dayOfWeek);
    if (!hoursRow || !hoursRow.status) {
        return false;
    }

    return isTimeSlotWithinHoursWindow(
        dateStr,
        collectionTimeFrom,
        collectionTimeTo,
        tz,
        hoursRow.openTime,
        hoursRow.closeTime
    );
}

/**
 * Platform open now for the current day in the given country.
 * @param {number} countryId
 */
async function isPlatformOpenNow(countryId, timeZone, clientTimeZone) {
    const { now, dayOfWeek, date, tz } = await getWallClockContextForCountry(
        countryId,
        timeZone,
        clientTimeZone
    );
    const platformRow = await findTodayPlatformHoursRow(dayOfWeek, countryId);
    if (!platformRow || !platformRow.status) return false;
    return isNowWithinHoursWindow(
        now,
        date,
        tz,
        platformRow.openTime,
        platformRow.closeTime
    );
}

/**
 * Shop open now: platform window + shop day on + shop openTime <= now < closeTime.
 * @param {number} shopUserId - laundry shop owner users.id
 * @param {number} [countryId] - defaults from shop address / zone
 */
async function isShopOpenNow(shopUserId, countryId, timeZone, clientTimeZone) {
    if (!shopUserId) return false;

    let resolvedCountryId = countryId;
    if (!resolvedCountryId) {
        const ctx = await getCountryContextFromShopUserId(shopUserId);
        resolvedCountryId = ctx.countryId;
    }

    const { tz, now, dayOfWeek, date } = await getWallClockContextForCountry(
        resolvedCountryId,
        timeZone,
        clientTimeZone
    );

    const platformRow = await findTodayPlatformHoursRow(
        dayOfWeek,
        resolvedCountryId
    );
    if (!platformRow || !platformRow.status) return false;
    if (
        !isNowWithinHoursWindow(
            now,
            date,
            tz,
            platformRow.openTime,
            platformRow.closeTime
        )
    ) {
        return false;
    }

    const hoursRow = await findTodayWorkingHoursRow(shopUserId, dayOfWeek);

    if (!hoursRow || !hoursRow.status) return false;

    return isNowWithinHoursWindow(
        now,
        date,
        tz,
        hoursRow.openTime,
        hoursRow.closeTime
    );
}

/**
 * Shop schedule open now (shop working hours only — no platform gate).
 */
async function isShopScheduleOpenNow(shopUserId, countryId, timeZone, clientTimeZone) {
    if (!shopUserId) return false;

    let resolvedCountryId = countryId;
    if (!resolvedCountryId) {
        const ctx = await getCountryContextFromShopUserId(shopUserId);
        resolvedCountryId = ctx.countryId;
    }

    const { tz, now, dayOfWeek, date } = await getWallClockContextForCountry(
        resolvedCountryId,
        timeZone,
        clientTimeZone
    );

    const hoursRow = await findTodayWorkingHoursRow(shopUserId, dayOfWeek);
    if (!hoursRow || !hoursRow.status) return false;

    return isNowWithinHoursWindow(
        now,
        date,
        tz,
        hoursRow.openTime,
        hoursRow.closeTime
    );
}

/**
 * Shop can receive a booking broadcast.
 * When pickup is provided, it must fall within working hours on the pickup day
 * (collectionDate). Day off on that day blocks the booking for that agent.
 */
async function isShopEligibleForBroadcast(
    shopUserId,
    countryId,
    timeZone,
    clientTimeZone,
    pickup = null
) {
    if (
        pickup?.collectionDate != null &&
        pickup?.collectionTimeFrom &&
        pickup?.collectionTimeTo
    ) {
        const pickupOk = await isPickupWithinShopWorkingHours(
            shopUserId,
            pickup.collectionDate,
            pickup.collectionTimeFrom,
            pickup.collectionTimeTo,
            timeZone,
            clientTimeZone,
            countryId
        );
        if (!pickupOk) {
            return false;
        }
    }

    if (await isAgentOnline(shopUserId)) {
        return true;
    }

    const platformOpen = await isPlatformOpenNow(
        countryId,
        timeZone,
        clientTimeZone
    );
    if (!platformOpen) {
        return false;
    }

    return isShopOpenNow(shopUserId, countryId, timeZone, clientTimeZone);
}

/**
 * At least one shop in zone can receive orders (app online or schedule open).
 */
async function isAnyShopOpenInZone(zoneId, timeZone, clientTimeZone) {
    const countryCtx = await getCountryContextFromZoneId(zoneId);

    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["userId"],
    });

    const resolvedTz = timeZone || countryCtx.ianaTimeZone;

    for (const shop of shops) {
        if (await isAgentOnline(shop.userId)) {
            return true;
        }
        if (
            await isShopOpenNow(
                shop.userId,
                countryCtx.countryId,
                resolvedTz,
                clientTimeZone
            )
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Shop owner user IDs in zone that can receive orders now.
 */
async function getOpenShopUserIdsInZone(zoneId, timeZone, clientTimeZone) {
    const countryCtx = await getCountryContextFromZoneId(zoneId);

    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["userId"],
    });

    const resolvedTz = timeZone || countryCtx.ianaTimeZone;
    const openIds = new Set();

    for (const shop of shops) {
        if (await isAgentOnline(shop.userId)) {
            openIds.add(shop.userId);
            continue;
        }
        if (
            await isShopOpenNow(
                shop.userId,
                countryCtx.countryId,
                resolvedTz,
                clientTimeZone
            )
        ) {
            openIds.add(shop.userId);
        }
    }
    return openIds;
}

module.exports = {
    DAY_NAMES,
    isShopOpenNow,
    isShopScheduleOpenNow,
    isShopEligibleForBroadcast,
    isPickupWithinShopWorkingHours,
    isPlatformOpenNow,
    isAnyShopOpenInZone,
    getOpenShopUserIdsInZone,
    getWallClockContext,
    getWallClockContextForCountry,
    findTodayWorkingHoursRow,
    findTodayPlatformHoursRow,
};
