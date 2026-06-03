const { ValidationError } = require("../middlewares/universalErrorHandler");

const DAY_ORDER = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function normalizeTimeString(timeValue) {
  if (!timeValue) return null;
  const raw = String(timeValue).trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  return null;
}

function timeToMinutes(timeValue) {
  const normalized = normalizeTimeString(timeValue);
  if (!normalized) return null;
  const [hh, mm] = normalized.split(":").map(Number);
  return hh * 60 + mm;
}

function buildPlatformMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    map.set(row.dayOfWeek, row);
  }
  return map;
}

/**
 * Validate shop hours fit inside platform hours for each day.
 */
function assertShopHoursWithinPlatform(shopDays, platformRows) {
  const platformMap =
    platformRows instanceof Map
      ? platformRows
      : buildPlatformMap(platformRows);

  for (const day of shopDays || []) {
    const dayOfWeek = day.dayOfWeek;
    const platform = platformMap.get(dayOfWeek);
    if (!platform) {
      throw new ValidationError(`Platform hours missing for ${dayOfWeek}`);
    }

    const shopOpen = Boolean(day.status);
    const platformOpen = Boolean(platform.status);

    if (shopOpen && !platformOpen) {
      throw new ValidationError(
        `${dayOfWeek}: shop cannot be open when platform is closed for this day`
      );
    }

    if (!shopOpen) continue;

    const shopOpenMin = timeToMinutes(day.openTime);
    const shopCloseMin = timeToMinutes(day.closeTime);
    const platformOpenMin = timeToMinutes(platform.openTime);
    const platformCloseMin = timeToMinutes(platform.closeTime);

    if (
      shopOpenMin == null ||
      shopCloseMin == null ||
      platformOpenMin == null ||
      platformCloseMin == null
    ) {
      throw new ValidationError(`${dayOfWeek}: invalid open or close time`);
    }

    if (shopOpenMin >= shopCloseMin) {
      throw new ValidationError(
        `${dayOfWeek}: shop close time must be after open time`
      );
    }

    if (shopOpenMin < platformOpenMin || shopCloseMin > platformCloseMin) {
      throw new ValidationError(
        `${dayOfWeek}: shop hours must be within platform hours (${platform.openTime} – ${platform.closeTime})`
      );
    }
  }
}

module.exports = {
  DAY_ORDER,
  normalizeTimeString,
  timeToMinutes,
  buildPlatformMap,
  assertShopHoursWithinPlatform,
};
