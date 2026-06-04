const moment = require("moment-timezone");
const { ValidationError } = require("../middlewares/universalErrorHandler");
const { BUSINESS_TIME_ZONE } = require("./bookingTimeZone");

/**
 * Normalize timeZone / clientTimeZone from request body.
 * @returns {string|null} IANA zone or null if not provided
 */
function parseTimeZoneFromBody(data) {
  const raw = data?.timeZone || data?.clientTimeZone;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!moment.tz.zone(trimmed)) {
    throw new ValidationError(`Unsupported timeZone: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Resolve agent IANA timezone: body override, then saved user field, then fallback.
 */
function resolveAgentTimeZone(data, savedIanaTimeZone, fallback = BUSINESS_TIME_ZONE) {
  const fromBody = parseTimeZoneFromBody(data);
  if (fromBody) return fromBody;
  if (savedIanaTimeZone && moment.tz.zone(String(savedIanaTimeZone).trim())) {
    return String(savedIanaTimeZone).trim();
  }
  return fallback;
}

module.exports = {
  parseTimeZoneFromBody,
  resolveAgentTimeZone,
};
