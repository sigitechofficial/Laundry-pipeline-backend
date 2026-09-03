const {
  addressDb,
  cities,
  countries,
  zone,
} = require("../models");
const { BUSINESS_TIME_ZONE } = require("./bookingTimeZone");

const ZONE_CONTEXT_TTL_MS = 5 * 60 * 1000;
// This deployment is UK-only (BUSINESS_TIME_ZONE=Europe/London, UK address
// lookup APIs, UK Twilio number) — used only when no country can be resolved
// from DB rows at all (empty countries table, or the found row has no
// shortName), so callers like phone-dial-code inference never get stuck.
const DEFAULT_COUNTRY_SHORT_NAME = "GB";
const zoneContextCache = new Map();
let defaultCountryContextCache = null;
let defaultCountryContextCachedAt = 0;

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

async function getDefaultCountryContext() {
  const now = Date.now();
  if (
    defaultCountryContextCache &&
    now - defaultCountryContextCachedAt < ZONE_CONTEXT_TTL_MS
  ) {
    return defaultCountryContextCache;
  }

  const row = await countries.findOne({
    attributes: ["id", "name", "shortName", "ianaTimeZone"],
    order: [["id", "ASC"]],
  });
  const ctx = !row
    ? {
        countryId: 1,
        countryName: null,
        shortName: DEFAULT_COUNTRY_SHORT_NAME,
        ianaTimeZone: BUSINESS_TIME_ZONE,
      }
    : {
        countryId: row.id,
        countryName: row.name,
        // `shortName` was previously omitted here entirely, so every caller
        // that fell back to the default context (missing/unresolvable
        // countryId or zoneId — the common case for customer-entered
        // pickup/drop-off addresses) got shortName=undefined and could never
        // resolve a dial code from it (e.g. agent notify-customer phone
        // resolution failing on every booking).
        shortName: row.shortName || DEFAULT_COUNTRY_SHORT_NAME,
        ianaTimeZone: row.ianaTimeZone || BUSINESS_TIME_ZONE,
      };

  defaultCountryContextCache = ctx;
  defaultCountryContextCachedAt = now;
  return ctx;
}

function contextFromCountryRow(countryRow) {
  if (!countryRow) return null;
  return {
    countryId: countryRow.id,
    countryName: countryRow.name,
    shortName: countryRow.shortName,
    ianaTimeZone: countryRow.ianaTimeZone || BUSINESS_TIME_ZONE,
  };
}

async function getCountryContextById(countryId) {
  if (!countryId) return getDefaultCountryContext();
  const row = await countries.findByPk(countryId, {
    attributes: ["id", "name", "shortName", "ianaTimeZone"],
  });
  return contextFromCountryRow(row) || getDefaultCountryContext();
}

async function getCountryContextFromZoneId(zoneId) {
  if (!zoneId) return getDefaultCountryContext();

  const cacheKey = String(zoneId);
  const cached = zoneContextCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < ZONE_CONTEXT_TTL_MS) {
    return cached.value;
  }

  const row = await zone.findOne({
    where: { id: zoneId },
    attributes: ["id"],
    include: zoneCountryInclude,
  });

  const countryRow = row?.city?.country;
  const value =
    contextFromCountryRow(countryRow) || (await getDefaultCountryContext());
  zoneContextCache.set(cacheKey, { at: now, value });
  return value;
}

async function getCountryContextFromShopUserId(shopUserId) {
  if (!shopUserId) return getDefaultCountryContext();

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

  return getDefaultCountryContext();
}

module.exports = {
  getCountryContextById,
  getCountryContextFromZoneId,
  getCountryContextFromShopUserId,
  getDefaultCountryContext,
};
