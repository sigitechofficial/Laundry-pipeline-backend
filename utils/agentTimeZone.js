const moment = require("moment-timezone");
const { ValidationError } = require("../middlewares/universalErrorHandler");

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
 * The agent app's display time zone (sign-in / session responses): the
 * device's zone from the body, then the one saved from an earlier sign-in,
 * then the shop's own operational zone (its country). Display-only: business
 * times always use the operational zone from data. With none of them known
 * the answer is null, not an assumed zone.
 *
 * @param {object} data request body
 * @param {string|null} savedIanaTimeZone users.ianaTimeZone
 * @param {string|null} shopTimeZone the shop's country zone, when it has one
 * @returns {string|null}
 */
function resolveAgentTimeZone(data, savedIanaTimeZone, shopTimeZone) {
  const fromBody = parseTimeZoneFromBody(data);
  if (fromBody) return fromBody;
  for (const candidate of [savedIanaTimeZone, shopTimeZone]) {
    const tz = candidate ? String(candidate).trim() : "";
    if (tz && moment.tz.zone(tz)) return tz;
  }
  return null;
}

module.exports = {
  parseTimeZoneFromBody,
  resolveAgentTimeZone,
};
