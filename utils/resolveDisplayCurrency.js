'use strict';

/**
 * Enterprise currency resolution for admin aggregates and reports.
 * Order: zone → city → country (unanimous zone currency) → country ISO map → first active zone → GBP.
 */

const { Op } = require('sequelize');

const DEFAULT_CURRENCY = Object.freeze({
    currencySymbol: '£',
    currencyCode: 'GBP',
});

const COUNTRY_ISO_TO_CURRENCY = Object.freeze({
    GB: { currencySymbol: '£', currencyCode: 'GBP' },
    UK: { currencySymbol: '£', currencyCode: 'GBP' },
    US: { currencySymbol: '$', currencyCode: 'USD' },
    AE: { currencySymbol: 'د.إ', currencyCode: 'AED' },
    SA: { currencySymbol: '﷼', currencyCode: 'SAR' },
    PK: { currencySymbol: 'Rs', currencyCode: 'PKR' },
    IN: { currencySymbol: '₹', currencyCode: 'INR' },
    IE: { currencySymbol: '€', currencyCode: 'EUR' },
    DE: { currencySymbol: '€', currencyCode: 'EUR' },
    FR: { currencySymbol: '€', currencyCode: 'EUR' },
    CA: { currencySymbol: '$', currencyCode: 'CAD' },
    AU: { currencySymbol: '$', currencyCode: 'AUD' },
});

function parsePositiveInt(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function fromUnit(unit) {
    if (!unit) return null;
    const currencySymbol = unit.symbol != null ? String(unit.symbol).trim() : '';
    const currencyCode = unit.name != null ? String(unit.name).trim() : '';
    if (!currencySymbol && !currencyCode) return null;
    return {
        currencySymbol: currencySymbol || currencyCode,
        currencyCode: currencyCode || '',
    };
}

function currencyKey(c) {
    if (!c) return '';
    return `${String(c.currencyCode || '').toUpperCase()}|${String(c.currencySymbol || '')}`;
}

function currencyFromCountryIso(shortName) {
    const iso = shortName != null ? String(shortName).trim().toUpperCase() : '';
    if (!iso || !COUNTRY_ISO_TO_CURRENCY[iso]) return null;
    return { ...COUNTRY_ISO_TO_CURRENCY[iso] };
}

/**
 * Resolve a currency units.id for a country (by shortName → ISO code → units.name).
 * Prefers the lowest id when duplicates exist.
 * @param {number|string} countryId
 * @returns {Promise<number|null>}
 */
async function resolveCurrencyUnitIdForCountry(countryId) {
    const id = parsePositiveInt(countryId);
    if (!id) return null;
    const { units, countries } = require('../models');
    const country = await countries.findByPk(id, { attributes: ['id', 'shortName'] });
    const mapped = currencyFromCountryIso(country?.shortName);
    if (!mapped?.currencyCode) return null;

    const unit = await units.findOne({
        where: {
            type: 'currency',
            name: mapped.currencyCode,
        },
        order: [['id', 'ASC']],
        attributes: ['id', 'name', 'symbol'],
    });
    return unit?.id != null ? Number(unit.id) : null;
}

/**
 * @param {object} filters - { zoneId, cityId, countryId }
 * @param {{ applyDefault?: boolean }} [options]
 * @returns {Promise<{ currencySymbol: string, currencyCode: string }>}
 */
async function resolveDisplayCurrency(filters = {}, options = {}) {
    const { applyDefault = true } = options;
    const { zone, units, cities, countries } = require('../models');

    const include = [{
        model: units,
        as: 'currencyUnitZ',
        attributes: ['symbol', 'name'],
        required: false,
    }];

    const zoneId = parsePositiveInt(filters.zoneId);
    if (zoneId) {
        const z = await zone.findByPk(zoneId, {
            include: [
                ...include,
                {
                    model: cities,
                    attributes: ['id', 'countryId'],
                    required: false,
                    include: [{
                        model: countries,
                        attributes: ['id', 'shortName'],
                        required: false,
                    }],
                },
            ],
            paranoid: true,
        });
        const fromZone = fromUnit(z?.currencyUnitZ);
        if (fromZone) return fromZone;
        // Zone row without currency → fall through via its city/country.
        if (z?.cityId && !filters.cityId) {
            filters = { ...filters, cityId: z.cityId };
        }
        const zoneCountryId = z?.city?.countryId ?? z?.city?.country?.id;
        if (zoneCountryId && !filters.countryId) {
            filters = { ...filters, countryId: zoneCountryId };
        }
    }

    const cityId = parsePositiveInt(filters.cityId);
    if (cityId) {
        const z = await zone.findOne({
            where: { cityId, status: true },
            include,
            order: [['id', 'ASC']],
            paranoid: true,
        });
        const fromCityZone = fromUnit(z?.currencyUnitZ);
        if (fromCityZone) return fromCityZone;

        const city = await cities.findByPk(cityId, {
            attributes: ['id', 'countryId'],
            include: [{
                model: countries,
                attributes: ['id', 'shortName'],
                required: false,
            }],
        });
        const cityCountryId = city?.countryId ?? city?.country?.id;
        if (cityCountryId && !filters.countryId) {
            filters = { ...filters, countryId: cityCountryId };
        }
    }

    const countryId = parsePositiveInt(filters.countryId);
    if (countryId) {
        const cityRows = await cities.findAll({
            where: { countryId },
            attributes: ['id'],
        });
        const cityIds = cityRows.map((c) => c.id);
        if (cityIds.length) {
            const zones = await zone.findAll({
                where: { cityId: { [Op.in]: cityIds }, status: true },
                include,
                order: [['id', 'ASC']],
                paranoid: true,
            });
            const currencies = zones
                .map((z) => fromUnit(z.currencyUnitZ))
                .filter(Boolean);
            if (currencies.length) {
                const keys = new Set(currencies.map(currencyKey));
                // Unanimous country currency only — mixed returns empty unless defaulted later.
                if (keys.size === 1) return currencies[0];
                if (!applyDefault) {
                    return { currencySymbol: '', currencyCode: '' };
                }
            }
        }

        const country = await countries.findByPk(countryId, {
            attributes: ['id', 'shortName'],
        });
        const fromIso = currencyFromCountryIso(country?.shortName);
        if (fromIso) return fromIso;
    }

    const fallbackZone = await zone.findOne({
        where: { status: true },
        include,
        order: [['id', 'ASC']],
        paranoid: true,
    });
    const fromFallback = fromUnit(fallbackZone?.currencyUnitZ);
    if (fromFallback) return fromFallback;

    if (!applyDefault) return { currencySymbol: '', currencyCode: '' };
    return { ...DEFAULT_CURRENCY };
}

module.exports = {
    DEFAULT_CURRENCY,
    COUNTRY_ISO_TO_CURRENCY,
    resolveDisplayCurrency,
    resolveCurrencyUnitIdForCountry,
};
