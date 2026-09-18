/**
 * Turnaround (timeRequired) validation helpers.
 */

function parseTimeRequiredDays(value) {
    if (value == null || value === '') return 0;

    // `timeRequired` holds human-readable strings like "48-72 hours",
    // "24-48 hours", "2 days", or a bare day count. Take the largest number
    // in the string (upper bound of any range) and convert by unit.
    // NOTE: never strip separators and concatenate digits — "48-72 hours"
    // must become 3 days (ceil 72h), not 4872 days.
    const str = String(value).trim().toLowerCase();
    const nums = (str.match(/\d+(?:\.\d+)?/g) || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) return 0;
    const maxNum = Math.max(...nums);

    // Hours → round up to whole days. Anything else (incl. a bare number
    // or "days") is treated as days for backward compatibility.
    if (/hour|hr\b|hrs\b/.test(str)) {
        return Math.max(1, Math.ceil(maxNum / 24));
    }
    return Math.ceil(maxNum);
}

function addDaysToIsoDate(isoDate, days) {
    if (!isoDate || typeof isoDate !== 'string') return '';
    const parts = isoDate.split('-').map(Number);
    if (parts.length < 3) return '';
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + (Number(days) || 0));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getMinDeliveryDate(collectionIso, turnaroundDays) {
    if (!collectionIso) return '';
    const days = parseTimeRequiredDays(turnaroundDays);
    if (days === 0) {
        return addDaysToIsoDate(collectionIso, 1);
    }
    return addDaysToIsoDate(collectionIso, days);
}

function getDatePartOnly(dateValue) {
    if (!dateValue) return '';
    const s = String(dateValue);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * @param {import('sequelize').Model[]} services - service rows with timeRequired
 * @returns {{ maxDays: number, minDeliveryDate: string, names: string[] }}
 */
function getMaxTurnaroundFromServiceRows(services) {
    let maxDays = 0;
    const names = [];
    for (const row of services || []) {
        const d = parseTimeRequiredDays(row.timeRequired);
        if (d > maxDays) {
            maxDays = d;
            names.length = 0;
            names.push(row.name || `Service ${row.id}`);
        } else if (d === maxDays && d > 0) {
            names.push(row.name || `Service ${row.id}`);
        }
    }
    return { maxDays, names };
}

/**
 * Throws ValidationError if delivery is before required turnaround.
 * @param {Object} serviceModel - Sequelize service model
 * @param {number[]} serviceIds
 * @param {string} collectionDate
 * @param {string} deliveryDate
 * @param {typeof ValidationError} ValidationError
 */
async function assertDeliveryMeetsTurnaround(
    serviceModel,
    serviceIds,
    collectionDate,
    deliveryDate,
    ValidationError
) {
    const ids = [...new Set((serviceIds || []).map((id) => Number(id)).filter(Boolean))];
    if (!ids.length) return;

    const collectionIso = getDatePartOnly(collectionDate);
    const deliveryIso = getDatePartOnly(deliveryDate);
    if (!collectionIso || !deliveryIso) return;

    const rows = await serviceModel.findAll({
        where: { id: ids, status: true },
        attributes: ['id', 'name', 'timeRequired'],
    });

    const { maxDays, names } = getMaxTurnaroundFromServiceRows(rows);
    if (!maxDays) return;

    const minDelivery = getMinDeliveryDate(collectionIso, maxDays);
    if (deliveryIso < minDelivery) {
        const label = names.length ? names.join(', ') : 'selected services';
        throw new ValidationError(
            `Delivery must be on or after ${minDelivery} (${maxDays} day turnaround for ${label}).`
        );
    }
}

module.exports = {
    parseTimeRequiredDays,
    addDaysToIsoDate,
    getMinDeliveryDate,
    getDatePartOnly,
    assertDeliveryMeetsTurnaround,
};
