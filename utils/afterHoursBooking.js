const moment = require("moment-timezone");
const platformOperationalHoursService = require("../services/Admin/platformOperationalHoursService");
const { normalizeTimeString } = require("./platformOperationalHours");
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

/** Hours after platform open time when after-hours placed bookings expire. */
const AFTER_HOURS_EXPIRY_BUFFER_HOURS = 1;

/**
 * Next platform-open instant strictly after placedAt, plus buffer (default +1 hour).
 * Used when customer books outside platform operational hours.
 *
 * @param {number} countryId
 * @param {string} [timeZone]
 * @param {string} [clientTimeZone]
 * @param {Date|string|moment.Moment} [placedAt]
 */
async function getAfterHoursOrderExpireTime(
    countryId,
    timeZone,
    clientTimeZone,
    placedAt = null
) {
    const platformData = await platformOperationalHoursService.getAll(countryId);
    const platformMap = new Map(
        (platformData.days || []).map((row) => [row.dayOfWeek, row])
    );

    const tz = resolveBookingTimeZone(timeZone, clientTimeZone);
    const placed = placedAt
        ? moment.tz(placedAt, tz)
        : moment.tz(tz);

    let dayCursor = placed.clone().startOf("day");

    for (let guard = 0; guard < 8; guard += 1) {
        const dayOfWeek = DAY_NAMES[dayCursor.day()];
        const platform = platformMap.get(dayOfWeek);

        if (platform?.status) {
            const openStr = normalizeTimeString(platform.openTime);
            if (openStr) {
                const openAt = moment.tz(
                    `${dayCursor.format("YYYY-MM-DD")} ${openStr}`,
                    "YYYY-MM-DD HH:mm:ss",
                    tz
                );

                if (openAt.isAfter(placed)) {
                    const expireAt = openAt
                        .clone()
                        .add(AFTER_HOURS_EXPIRY_BUFFER_HOURS, "hours");
                    return {
                        orderExpireTime: expireAt.format("HH:mm:ss"),
                        expireAt,
                        platformOpenDay: dayCursor.format("YYYY-MM-DD"),
                        platformOpenTime: openStr,
                    };
                }
            }
        }

        dayCursor = dayCursor.add(1, "day");
    }

    const fallback = placed.clone().add(24, "hours");
    return {
        orderExpireTime: fallback.format("HH:mm:ss"),
        expireAt: fallback,
        platformOpenDay: fallback.format("YYYY-MM-DD"),
        platformOpenTime: null,
    };
}

module.exports = {
    AFTER_HOURS_EXPIRY_BUFFER_HOURS,
    getAfterHoursOrderExpireTime,
};
