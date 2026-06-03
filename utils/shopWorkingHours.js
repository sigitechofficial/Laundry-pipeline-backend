const moment = require("moment-timezone");
const {
    addressDb,
    bussinessWorkingHours,
    bussinessInformation,
    platformOperationalHours,
} = require("../models");
const { resolveBookingTimeZone } = require("./bookingTimeZone");

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
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
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
 * Resolve today's hours row for a shop owner (userId or bussinessInformation link).
 */
async function findTodayWorkingHoursRow(shopUserId, dayOfWeek) {
    let hoursRow = await bussinessWorkingHours.findOne({
        where: { userId: shopUserId, dayOfWeek },
        attributes: ["openTime", "closeTime", "status", "dayOfWeek"],
    });

    if (!hoursRow) {
        const biz = await bussinessInformation.findOne({
            where: { userId: shopUserId },
            attributes: ["id"],
        });
        if (biz?.id) {
            hoursRow = await bussinessWorkingHours.findOne({
                where: { bussinessInformationId: biz.id, dayOfWeek },
                attributes: ["openTime", "closeTime", "status", "dayOfWeek"],
            });
        }
    }

    return hoursRow;
}

async function findTodayPlatformHoursRow(dayOfWeek) {
    return platformOperationalHours.findOne({
        where: { dayOfWeek },
        attributes: ["openTime", "closeTime", "status", "dayOfWeek"],
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
 * Platform open now for the current day.
 */
async function isPlatformOpenNow(timeZone, clientTimeZone) {
    const { now, dayOfWeek, date, tz } = getWallClockContext(
        timeZone,
        clientTimeZone
    );
    const platformRow = await findTodayPlatformHoursRow(dayOfWeek);
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
 */
async function isShopOpenNow(shopUserId, timeZone, clientTimeZone) {
    if (!shopUserId) return false;

    const { tz, now, dayOfWeek, date } = getWallClockContext(
        timeZone,
        clientTimeZone
    );

    const platformRow = await findTodayPlatformHoursRow(dayOfWeek);
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
 * At least one laundry shop in zone is open right now.
 */
async function isAnyShopOpenInZone(zoneId, timeZone, clientTimeZone) {
    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["userId"],
    });

    for (const shop of shops) {
        if (await isShopOpenNow(shop.userId, timeZone, clientTimeZone)) {
            return true;
        }
    }
    return false;
}

/**
 * Shop user IDs in zone that are open now.
 */
async function getOpenShopUserIdsInZone(zoneId, timeZone, clientTimeZone) {
    const shops = await addressDb.findAll({
        where: {
            zoneId,
            addressType: "LaundaryShopAddress",
        },
        attributes: ["userId"],
    });

    const openIds = new Set();
    for (const shop of shops) {
        if (await isShopOpenNow(shop.userId, timeZone, clientTimeZone)) {
            openIds.add(shop.userId);
        }
    }
    return openIds;
}

module.exports = {
    isShopOpenNow,
    isPlatformOpenNow,
    isAnyShopOpenInZone,
    getOpenShopUserIdsInZone,
    getWallClockContext,
    findTodayWorkingHoursRow,
    findTodayPlatformHoursRow,
};
