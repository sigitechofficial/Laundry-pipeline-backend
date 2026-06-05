const moment = require("moment-timezone");
const { ValidationError } = require("../../middlewares/universalErrorHandler");
const platformOperationalHoursService = require("../Admin/platformOperationalHoursService");
const {
  getCountryContextById,
  getCountryContextFromZoneId,
} = require("../../utils/countryTimeZone");
const {
  timeToMinutes,
  normalizeTimeString,
} = require("../../utils/platformOperationalHours");

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function parseClientTimeZone(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || !moment.tz.zone(trimmed)) {
    throw new ValidationError(`Unsupported clientTimeZone: ${raw}`);
  }
  return trimmed;
}

function buildTzBlock(ianaTimeZone, countryName, shortLabelOverride) {
  const now = moment.tz(ianaTimeZone);
  const shortLabel =
    shortLabelOverride ||
    (countryName ? `${countryName} time` : "Service time");
  return {
    ianaTimeZone,
    countryName: countryName || null,
    shortLabel,
    displayLabel: `${countryName || ianaTimeZone} (${ianaTimeZone})`,
    utcOffsetNow: now.format("Z"),
    abbreviationNow: now.format("z"),
    nowIso: now.format("YYYY-MM-DDTHH:mm:ssZ"),
    nowFormatted: now.format("h:mm A"),
  };
}

function format12h(momentObj) {
  return momentObj.format("h:mm A");
}

function format24h(momentObj) {
  return momentObj.format("HH:mm");
}

function slotLocalTimes(dateStr, startMoment, endMoment, operationalTz, clientTz) {
  if (!clientTz || clientTz === operationalTz) return null;
  const localStart = startMoment.clone().tz(clientTz);
  const localEnd = endMoment.clone().tz(clientTz);
  return {
    ianaTimeZone: clientTz,
    start: format24h(localStart),
    end: format24h(localEnd),
    start12h: format12h(localStart),
    end12h: format12h(localEnd),
  };
}

/**
 * Build bookable slots from country platform operational hours.
 */
async function buildSlots({
  countryId,
  clientTimeZone,
  daysCount = 7,
  slotDurationMinutes = 60,
  startAfterHours = 2,
  fromDate = null,
}) {
  const cid = Number(countryId);
  if (!Number.isInteger(cid) || cid < 1) {
    throw new ValidationError("countryId is required");
  }

  const countryCtx = await getCountryContextById(cid);
  const operationalTz = countryCtx.ianaTimeZone;
  const platformData = await platformOperationalHoursService.getAll(cid);
  const platformMap = new Map(
    (platformData.days || []).map((row) => [row.dayOfWeek, row])
  );

  const now = moment.tz(operationalTz);
  let loopStart = now.clone().startOf("day");
  if (fromDate) {
    const fromMoment = moment.tz(fromDate, "YYYY-MM-DD", operationalTz).startOf("day");
    if (fromMoment.isAfter(loopStart)) {
      loopStart = fromMoment;
    }
  }

  const minFromNow = now.clone().add(Number(startAfterHours) || 0, "hours");
  if (minFromNow.minute() > 0 || minFromNow.second() > 0 || minFromNow.millisecond() > 0) {
    minFromNow.add(1, "hour").minute(0).second(0).millisecond(0);
  }

  const days = [];
  let cursor = loopStart.clone();
  let guard = 0;

  while (days.length < daysCount && guard < 90) {
    guard += 1;
    const dayOfWeek = DAY_NAMES[cursor.day()];
    const platform = platformMap.get(dayOfWeek);
    const dateStr = cursor.format("YYYY-MM-DD");

    if (platform?.status) {
      const openMin = timeToMinutes(platform.openTime);
      const closeMin = timeToMinutes(platform.closeTime);

      if (openMin != null && closeMin != null && openMin < closeMin) {
        const openMoment = cursor
          .clone()
          .hour(Math.floor(openMin / 60))
          .minute(openMin % 60)
          .second(0)
          .millisecond(0);
        const closeMoment = cursor
          .clone()
          .hour(Math.floor(closeMin / 60))
          .minute(closeMin % 60)
          .second(0)
          .millisecond(0);

        let slotStart;
        if (cursor.isSame(now, "day")) {
          if (minFromNow.isSameOrAfter(closeMoment)) {
            cursor.add(1, "day");
            continue;
          }
          slotStart = minFromNow.isBefore(openMoment)
            ? openMoment.clone()
            : minFromNow.clone();
        } else {
          slotStart = openMoment.clone();
        }

        const timeSlots = [];
        while (
          slotStart
            .clone()
            .add(slotDurationMinutes, "minutes")
            .isSameOrBefore(closeMoment)
        ) {
          const slotEnd = slotStart.clone().add(slotDurationMinutes, "minutes");
          timeSlots.push({
            start: format12h(slotStart),
            end: format12h(slotEnd),
            start24h: format24h(slotStart),
            end24h: format24h(slotEnd),
            operationalTimeZone: operationalTz,
            local: slotLocalTimes(
              dateStr,
              slotStart,
              slotEnd,
              operationalTz,
              clientTimeZone
            ),
          });
          slotStart = slotEnd.clone();
        }

        if (timeSlots.length > 0) {
          days.push({
            date: dateStr,
            dayLabel: cursor.format("ddd"),
            displayDate: String(cursor.date()),
            platformOpen: true,
            platformOpenTime: normalizeTimeString(platform.openTime)?.slice(0, 5),
            platformCloseTime: normalizeTimeString(platform.closeTime)?.slice(0, 5),
            timeSlots,
          });
        }
      }
    }

    cursor.add(1, "day");
  }

  const operational = buildTzBlock(
    operationalTz,
    countryCtx.countryName,
    countryCtx.countryName ? `${countryCtx.countryName} time` : "Service time"
  );

  const clientLocal = clientTimeZone
    ? buildTzBlock(clientTimeZone, null, "Your local time")
    : null;

  return {
    countryId: cid,
    countryName: countryCtx.countryName,
    operational,
    clientLocal,
    slotDurationMinutes,
    days,
  };
}

class BookingSlotsService {
  async getBookingSlots(data) {
    const {
      countryId,
      zoneId,
      clientTimeZone: clientTzRaw,
      type = "collection",
      daysCount,
      startAfterHours,
      fromDate,
    } = data;

    let resolvedCountryId = countryId ? Number(countryId) : null;
    if (!resolvedCountryId && zoneId) {
      const ctx = await getCountryContextFromZoneId(zoneId);
      resolvedCountryId = ctx.countryId;
    }
    if (!resolvedCountryId) {
      throw new ValidationError("countryId or zoneId is required");
    }

    const clientTimeZone = clientTzRaw ? parseClientTimeZone(clientTzRaw) : null;

    const isDelivery = String(type).toLowerCase() === "delivery";
    const resolvedDays = Number(daysCount) > 0 ? Number(daysCount) : isDelivery ? 21 : 7;
    const resolvedStartAfter = Number(startAfterHours);
    const resolvedStartAfterHours = Number.isFinite(resolvedStartAfter)
      ? resolvedStartAfter
      : isDelivery
        ? 24
        : 2;

    const slots = await buildSlots({
      countryId: resolvedCountryId,
      clientTimeZone,
      daysCount: resolvedDays,
      slotDurationMinutes: 60,
      startAfterHours: resolvedStartAfterHours,
      fromDate: fromDate || null,
    });

    return {
      message: "Booking slots",
      data: {
        type: isDelivery ? "delivery" : "collection",
        ...slots,
      },
    };
  }
}

module.exports = new BookingSlotsService();
