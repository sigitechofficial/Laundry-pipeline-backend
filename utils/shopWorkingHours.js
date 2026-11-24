const moment = require("moment-timezone");
const {
    addressDb,
    bussinessWorkingHours,
    bussinessInformation,
    platformOperationalHours,
} = require("../models");
const { requireOperationalTimeZone } = require("./bookingTimeZone");
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
 * Wall clock in an operational IANA zone (a country's, from data; never a
 * client-sent zone).
 * @param {string} timeZone operational IANA zone
 */
function getWallClockContext(timeZone) {
    const tz = requireOperationalTimeZone(timeZone);
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
 * Wall clock in the country's own IANA zone (countries.ianaTimeZone).
 * @param {number} countryId
 */
async function getWallClockContextForCountry(countryId) {
    const countryCtx = await getCountryContextById(countryId);
    const tz = countryCtx.ianaTimeZone;
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

/**
 * findTodayWorkingHoursRow of one shop, read once per weekday: for checking many bookings
 * of the same shop (the New list), where the answer only depends on the pickup weekday.
 * @param {number} shopUserId
 * @returns {(dayOfWeek: string) => Promise<object|null>}
 */
function workingHoursByDayLookup(shopUserId) {
    const byDay = new Map();
    return (dayOfWeek) => {
        if (!byDay.has(dayOfWeek)) {
            byDay.set(dayOfWeek, findTodayWorkingHoursRow(shopUserId, dayOfWeek));
        }
        return byDay.get(dayOfWeek);
    };
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

function resolvePickupDayContext(collectionDate, timeZone) {
    const tz = requireOperationalTimeZone(timeZone);
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
 *
 * @param {string} timeZone the booking's operational IANA zone (its slot times
 *   are wall clock there)
 * @param {(dayOfWeek: string) => Promise<object|null>} [hoursForDay] this shop's
 *   workingHoursByDayLookup, when checking several bookings of the shop
 */
async function isPickupWithinShopWorkingHours(
    shopUserId,
    collectionDate,
    collectionTimeFrom,
    collectionTimeTo,
    timeZone,
    hoursForDay = null
) {
    if (!shopUserId || collectionDate == null || !collectionTimeFrom || !collectionTimeTo) {
        return false;
    }

    const { tz, dateStr, dayOfWeek } = resolvePickupDayContext(
        collectionDate,
        timeZone
    );

    const hoursRow = hoursForDay
        ? await hoursForDay(dayOfWeek)
        : await findTodayWorkingHoursRow(shopUserId, dayOfWeek);
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
async function isPlatformOpenNow(countryId) {
    const { now, dayOfWeek, date, tz } = await getWallClockContextForCountry(countryId);
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
async function isShopOpenNow(shopUserId, countryId) {
    if (!shopUserId) return false;

    let resolvedCountryId = countryId;
    if (!resolvedCountryId) {
        const ctx = await getCountryContextFromShopUserId(shopUserId);
        resolvedCountryId = ctx.countryId;
    }

    const { tz, now, dayOfWeek, date } = await getWallClockContextForCountry(
        resolvedCountryId
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
async function isShopScheduleOpenNow(shopUserId, countryId) {
    if (!shopUserId) return false;

    let resolvedCountryId = countryId;
    if (!resolvedCountryId) {
        const ctx = await getCountryContextFromShopUserId(shopUserId);
        resolvedCountryId = ctx.countryId;
    }

    const { tz, now, dayOfWeek, date } = await getWallClockContextForCountry(
        resolvedCountryId
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
async function isShopEligibleForBroadcast(shopUserId, countryId, pickup = null) {
    if (
        pickup?.collectionDate != null &&
        pickup?.collectionTimeFrom &&
        pickup?.collectionTimeTo
    ) {
        const { ianaTimeZone } = await getCountryContextById(countryId);
        const pickupOk = await isPickupWithinShopWorkingHours(
            shopUserId,
            pickup.collectionDate,
            pickup.collectionTimeFrom,
            pickup.collectionTimeTo,
            ianaTimeZone
        );
        if (!pickupOk) {
            return false;
        }
    }

    if (await isAgentOnline(shopUserId)) {
        return true;
    }

    const platformOpen = await isPlatformOpenNow(countryId);
    if (!platformOpen) {
        return false;
    }

    return isShopOpenNow(shopUserId, countryId);
}

/**
 * At least one shop in zone can receive orders (app online or schedule open).
 */
async function isAnyShopOpenInZone(zoneId) {
    const countryCtx = await getCountryContextFromZoneId(zoneId);

    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["userId"],
    });


    for (const shop of shops) {
        if (await isAgentOnline(shop.userId)) {
            return true;
        }
        if (
            await isShopOpenNow(shop.userId, countryCtx.countryId)
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Shop owner user IDs in zone that can receive orders now.
 */
async function getOpenShopUserIdsInZone(zoneId) {
    const countryCtx = await getCountryContextFromZoneId(zoneId);

    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["userId"],
    });

    const openIds = new Set();

    for (const shop of shops) {
        if (await isAgentOnline(shop.userId)) {
            openIds.add(shop.userId);
            continue;
        }
        if (
            await isShopOpenNow(shop.userId, countryCtx.countryId)
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
    workingHoursByDayLookup,
    findTodayPlatformHoursRow,
};
