'use strict';

/**
 * Enterprise currency resolution for admin aggregates and reports.
 * Order: zone → city → country (unanimous zone currency) → first active zone → GBP.
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
        const z = await zone.findByPk(zoneId, { include, paranoid: true });
        const fromZone = fromUnit(z?.currencyUnitZ);
        if (fromZone) return fromZone;
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
        const iso = country?.shortName
            ? String(country.shortName).trim().toUpperCase()
            : '';
        if (iso && COUNTRY_ISO_TO_CURRENCY[iso]) {
            return { ...COUNTRY_ISO_TO_CURRENCY[iso] };
        }
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
    resolveDisplayCurrency,
};
