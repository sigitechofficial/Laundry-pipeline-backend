'use strict';

/**
 * Validation shared by every admin path that creates or edits a zone
 * (zoneManagementService.addZone / updateZone and postcodeZoneService.addZoneByPostcodes /
 * editZoneByPostcodes).
 *
 * A zone must always have a currency: all of its money is in it and nothing else
 * supplies one (zones.currencyUnitId is NOT NULL). On create the currency is required;
 * on edit it may be omitted (unchanged) but never cleared.
 */
const { cities, units, users } = require('../../models');
const { NotFoundError, ValidationError } = require('../../middlewares/universalErrorHandler');

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

function positiveIntOrNull(value) {
    if (blank(value)) return null;
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n > 0 ? n : null;
}

/**
 * The currency unit a zone payload names, checked: an existing, live unit of type
 * 'currency' with an ISO code (units.name). Returns its id.
 */
async function requireCurrencyUnitId(value) {
    if (blank(value)) {
        throw new ValidationError('Choose the zone currency (currencyUnitId); a zone must have one.');
    }
    const id = positiveIntOrNull(value);
    if (!id) throw new ValidationError('currencyUnitId must be a currency unit id');
    const unit = await units.findByPk(id, { attributes: ['id', 'type', 'name', 'deleted'] });
    if (!unit || unit.deleted) throw new NotFoundError('Currency unit not found');
    if (String(unit.type || '').trim().toLowerCase() !== 'currency') {
        throw new ValidationError('currencyUnitId must reference a currency unit');
    }
    if (blank(unit.name)) {
        throw new ValidationError(
            `Currency unit #${id} has no ISO code (units.name); fix the unit before using it for a zone.`
        );
    }
    return id;
}

/**
 * Validate (and normalise) a zone create / update payload in place.
 * @param {object} data zone fields
 * @param {{ creating: boolean }} options creating = new zone (currency required)
 */
async function validateZoneData(data, { creating }) {
    if (creating || data.currencyUnitId !== undefined) {
        data.currencyUnitId = await requireCurrencyUnitId(data.currencyUnitId);
    }

    if (data.cityId) {
        const cityExists = await cities.findByPk(data.cityId);
        if (!cityExists) throw new NotFoundError('City not found');
    }

    if (data.distanceUnitId) {
        const distanceUnit = await units.findByPk(data.distanceUnitId);
        if (!distanceUnit) throw new NotFoundError('Distance unit not found');
    }

    if (data.zoneAdminId) {
        const adminUser = await users.findByPk(data.zoneAdminId);
        if (!adminUser) throw new NotFoundError('Zone admin user not found');
    }
}

module.exports = { validateZoneData, requireCurrencyUnitId };
