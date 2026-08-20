'use strict';

/** Default page size for admin lists that already paginate (All Orders). */
const DEFAULT_LIST_LIMIT = 20;
/** Hard cap for paginated admin lists/reports. Client cannot request more. */
const DEFAULT_MAX_LIST_LIMIT = 100;
/** Safety cap when a list endpoint would otherwise return every row. */
const UNBOUNDED_LIST_SAFETY_MAX = 500;

/**
 * Clamp a client-supplied list/report page size.
 * Invalid or missing → defaultLimit. Never exceeds maxLimit.
 *
 * @param {unknown} raw
 * @param {number} [defaultLimit]
 * @param {number} [maxLimit]
 * @returns {number}
 */
function clampListLimit(
    raw,
    defaultLimit = DEFAULT_LIST_LIMIT,
    maxLimit = DEFAULT_MAX_LIST_LIMIT
) {
    const fallback = Number.isFinite(defaultLimit) && defaultLimit > 0
        ? defaultLimit
        : DEFAULT_LIST_LIMIT;
    const ceiling = Number.isFinite(maxLimit) && maxLimit > 0
        ? maxLimit
        : DEFAULT_MAX_LIST_LIMIT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, ceiling);
}

/**
 * @param {unknown} raw
 * @param {number} [defaultPage]
 * @returns {number}
 */
function clampPage(raw, defaultPage = 1) {
    const fallback = Number.isFinite(defaultPage) && defaultPage > 0 ? defaultPage : 1;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
}

module.exports = {
    clampListLimit,
    clampPage,
    DEFAULT_LIST_LIMIT,
    DEFAULT_MAX_LIST_LIMIT,
    UNBOUNDED_LIST_SAFETY_MAX,
};
