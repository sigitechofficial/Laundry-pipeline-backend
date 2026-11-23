const {
  addressDb,
  booking,
  cities,
  countries,
  zone,
} = require("../models");
const {
  NotFoundError,
  UnprocessableEntityError,
} = require("../middlewares/universalErrorHandler");
const {
  TIME_ZONE_UNRESOLVED,
  requireOperationalTimeZone,
  wallClockNow,
} = require("./bookingTimeZone");

const ZONE_CONTEXT_TTL_MS = 5 * 60 * 1000;
const zoneContextCache = new Map();

const zoneCountryInclude = [
  {
    model: cities,
    required: true,
    attributes: ["id"],
    include: [
      {
        model: countries,
        required: true,
        attributes: ["id", "name", "shortName", "ianaTimeZone"],
      },
    ],
  },
];

function unresolved(message) {
  return new UnprocessableEntityError(message, { code: TIME_ZONE_UNRESOLVED });
}

/**
 * Country context for business times. Every field comes from the country row;
 * there is no default country or zone. A country without a valid IANA zone is
 * a configuration error the caller surfaces (422), because computing its
 * times in any other zone would silently shift them.
 */
function contextFromCountryRow(countryRow) {
  return {
    countryId: countryRow.id,
    countryName: countryRow.name,
    shortName: countryRow.shortName || null,
    ianaTimeZone: requireOperationalTimeZone(
      countryRow.ianaTimeZone,
      `country "${countryRow.name || countryRow.id}"`
    ),
  };
}

async function getCountryContextById(countryId) {
  if (!countryId) {
    throw unresolved("No country is set, so its time zone cannot be resolved.");
  }
  const row = await countries.findByPk(countryId, {
    attributes: ["id", "name", "shortName", "ianaTimeZone"],
  });
  if (!row) {
    throw unresolved(`Country ${countryId} does not exist, so its time zone cannot be resolved.`);
  }
  return contextFromCountryRow(row);
}

async function getCountryContextFromZoneId(zoneId) {
  if (!zoneId) {
    throw unresolved("No zone is set, so its country's time zone cannot be resolved.");
  }

  const cacheKey = String(zoneId);
  const cached = zoneContextCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < ZONE_CONTEXT_TTL_MS) {
    return cached.value;
  }

  // A deleted zone keeps its country: its bookings still run on that clock.
  const row = await zone.findOne({
    where: { id: zoneId },
    attributes: ["id"],
    include: zoneCountryInclude,
    paranoid: false,
  });

  const countryRow = row?.city?.country;
  if (!countryRow) {
    throw unresolved(
      `Zone ${zoneId} has no city with a country, so its time zone cannot be resolved.`
    );
  }
  const value = contextFromCountryRow(countryRow);
  zoneContextCache.set(cacheKey, { at: now, value });
  return value;
}

async function getCountryContextFromShopUserId(shopUserId) {
  if (!shopUserId) {
    throw unresolved("No shop is set, so its time zone cannot be resolved.");
  }

  const shopAddress = await addressDb.findOne({
    where: {
      userId: shopUserId,
      addressType: "LaundaryShopAddress",
    },
    attributes: ["countryId", "zoneId"],
    order: [["id", "ASC"]],
  });

  if (shopAddress?.countryId) {
    return getCountryContextById(shopAddress.countryId);
  }
  if (shopAddress?.zoneId) {
    return getCountryContextFromZoneId(shopAddress.zoneId);
  }

  throw unresolved(
    `Shop ${shopUserId} has no shop address with a country or zone, so its time zone cannot be resolved.`
  );
}

/**
 * Each zone's country IANA zone, by zone id, as stored (null when its country
 * has none). Callers validate the ones they use (requireOperationalTimeZone),
 * so one misconfigured zone fails only what depends on it.
 *
 * @param {number[]|null} zoneIds the zones to read (deleted ones included, they
 *   keep their country); null reads every active zone
 * @returns {Promise<Map<number, string|null>>}
 */
async function getZoneTimeZones(zoneIds = null) {
  // Not required: a zone without a city / country is listed (null) so its callers report it.
  const rows = await zone.findAll({
    ...(zoneIds ? { where: { id: zoneIds }, paranoid: false } : { where: { status: true } }),
    attributes: ["id"],
    include: [{
      model: cities,
      required: false,
      attributes: ["id"],
      include: [{ model: countries, required: false, attributes: ["id", "ianaTimeZone"] }],
    }],
  });
  return new Map(
    rows.map((row) => [Number(row.id), row.city?.country?.ianaTimeZone || null])
  );
}

/**
 * The operational zones a check runs in: the given zone's own, or with no zone
 * every active zone's (validated, de-duplicated). Used where a calendar day has
 * no single zone, e.g. whether a campaign's end day is over everywhere.
 *
 * @param {number|null} [zoneId]
 * @returns {Promise<string[]>}
 */
async function getOperationalTimeZones(zoneId = null) {
  if (zoneId) return [(await getCountryContextFromZoneId(zoneId)).ianaTimeZone];
  const zoneTimeZones = await getZoneTimeZones();
  const timeZones = [...new Set([...zoneTimeZones.entries()].map(
    ([id, tz]) => requireOperationalTimeZone(tz, `zone ${id}`)
  ))];
  if (!timeZones.length) {
    throw unresolved("No active zone exists, so there is no time zone to check the day in.");
  }
  return timeZones;
}

/**
 * The booking's operational IANA zone: the zone its slots and accept window
 * were set in. Stored on the booking at creation (bookings.operationalTimeZone,
 * from its zone's country); a booking without it takes its zone's country,
 * which is where that value comes from. Never a client time zone.
 *
 * @param {{ id?: number, operationalTimeZone?: string|null, zoneId?: number|null }} bookingRow
 * @returns {Promise<string>}
 */
async function resolveBookingOperationalTimeZone(bookingRow) {
  if (bookingRow?.operationalTimeZone) {
    return requireOperationalTimeZone(
      bookingRow.operationalTimeZone,
      `booking ${bookingRow.id}`
    );
  }
  if (bookingRow?.zoneId) {
    return (await getCountryContextFromZoneId(bookingRow.zoneId)).ianaTimeZone;
  }
  throw unresolved(
    `Booking ${bookingRow?.id} has neither an operational time zone nor a zone.`
  );
}

/**
 * Wall-clock now on the booking's operational clock, for its status history
 * and invoice-line stamps (never the device's zone of whoever acted).
 *
 * @param {number|string} bookingId
 * @returns {Promise<{ date: string, time: string, timeHHmm: string, timeZone: string }>}
 */
async function bookingWallClockNow(bookingId) {
  const row = await booking.findByPk(bookingId, {
    attributes: ["id", "operationalTimeZone", "zoneId"],
  });
  if (!row) {
    throw new NotFoundError(`Booking ${bookingId} not found`);
  }
  return wallClockNow(await resolveBookingOperationalTimeZone(row));
}

/**
 * The shop's own IANA zone: the country of its LaundaryShopAddress (by
 * countryId, else through its zone's city). Unlike the context helpers above
 * this never substitutes a default: a shop whose country has no valid zone is
 * a configuration error the caller must surface, because day boundaries
 * computed in another zone would silently move orders between days.
 *
 * @param {{ countryId?: number|null, zoneId?: number|null }} shopAddress
 * @returns {Promise<string>}
 */
async function requireShopTimeZone(shopAddress) {
  let countryRow = null;
  if (shopAddress?.countryId) {
    countryRow = await countries.findByPk(shopAddress.countryId, {
      attributes: ["id", "ianaTimeZone"],
    });
  }
  if (!countryRow && shopAddress?.zoneId) {
    const zoneRow = await zone.findOne({
      where: { id: shopAddress.zoneId },
      attributes: ["id"],
      include: zoneCountryInclude,
      paranoid: false,
    });
    countryRow = zoneRow?.city?.country || null;
  }

  if (!countryRow) {
    throw unresolved(
      "The shop's time zone is not configured (its address has no country or zone)."
    );
  }
  return requireOperationalTimeZone(countryRow.ianaTimeZone, "the shop's country");
}

module.exports = {
  getCountryContextById,
  getCountryContextFromZoneId,
  getCountryContextFromShopUserId,
  getZoneTimeZones,
  getOperationalTimeZones,
  resolveBookingOperationalTimeZone,
  bookingWallClockNow,
  requireShopTimeZone,
};
