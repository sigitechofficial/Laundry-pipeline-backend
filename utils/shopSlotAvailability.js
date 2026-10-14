'use strict';

/**
 * Date / time normalising for booking slots (used by slot capacity and the
 * nearest-trip sort).
 *
 * `collectionDate` / `deliveryDate` are DATETIME columns whose time part is not
 * meaningful — the slot is carried by the separate TIME columns — so slot
 * matching compares on the date only.
 */

/**
 * `YYYY-MM-DD` in the calendar the value was stored in. Sequelize hands back a
 * Date built from the connection timezone, so read local parts rather than
 * going through toISOString(), which would shift the day either side of UTC.
 */
function toDateOnly(value) {
    if (!value) return null;

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    const text = String(value).trim();
    const leadingDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (leadingDate) return leadingDate[1];

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : toDateOnly(parsed);
}

/** `HH:MM` and `HH:MM:SS` both arrive from clients; normalise to `HH:MM:SS`. */
function toTimeOnly(value) {
    if (!value) return null;

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const hours = String(value.getHours()).padStart(2, '0');
        const minutes = String(value.getMinutes()).padStart(2, '0');
        const seconds = String(value.getSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    const match = String(value)
        .trim()
        .match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;

    const hours = String(Number(match[1])).padStart(2, '0');
    return `${hours}:${match[2]}:${match[3] || '00'}`;
}

module.exports = {
    toDateOnly,
    toTimeOnly,
};
