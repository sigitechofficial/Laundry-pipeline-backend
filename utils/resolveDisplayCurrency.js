'use strict';

/**
 * Currency resolution from data only: a zone's currency is its `currencyUnitId` →
 * `units` row (zones.currencyUnitId is NOT NULL, see migration
 * 20261123160000-zones-currency-unit-required). Nothing here invents a currency —
 * no platform default, no country → currency table, no "first active zone".
 *
 *  - zone filter            → that zone's currency (soft-deleted zones too: historic
 *                             bookings keep the currency they were priced in);
 *  - city / country / none  → the currency shared by ALL matching active zones.
 *
 * When there is no single answer (no matching zone, or zones in different currencies)
 * the result is EMPTY — `{ currencySymbol: '', currencyCode: '' }`, an honest
 * "unknown / mixed". Admin aggregates that span currencies must not be labelled with
 * one of them; pure money helpers that need a currency throw on EMPTY
 * (utils/requireCurrency).
 */

const { Op } = require('sequelize');

const EMPTY = Object.freeze({ currencySymbol: '', currencyCode: '' });

function empty() {
    return { ...EMPTY };
}

function parsePositiveInt(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function trimmed(value) {
    return value != null ? String(value).trim() : '';
}

/**
 * A currency unit row → `{ currencySymbol, currencyCode }`, or null when there is none.
 *
 * The ISO code (units.name) identifies the currency: Stripe, bills and ledgers need it.
 * A unit without one is a data error, so it resolves to null (unknown) and is logged —
 * never half a currency with an empty code. A unit with a code but no symbol displays
 * its code (e.g. "CHF"), which is still the unit's own data.
 */
function fromUnit(unit) {
    if (!unit) return null;
    const currencyCode = trimmed(unit.name).toUpperCase();
    if (!currencyCode) {
        console.error(
            `[currency] units.id=${unit.id ?? '?'} has no ISO code (units.name); ` +
                'its zones resolve to an unknown currency until the unit is fixed.'
        );
        return null;
    }
    return { currencySymbol: trimmed(unit.symbol) || currencyCode, currencyCode };
}

function currencyUnitInclude() {
    const { units } = require('../models');
    return {
        model: units,
        as: 'currencyUnitZ',
        attributes: ['id', 'name', 'symbol'],
        required: false,
    };
}

/**
 * The currency shared by every zone matching `where`, or EMPTY when none match, when
 * they are in different currencies, or when any of them has an unknown currency.
 * Currencies are compared by ISO code.
 * @param {object} where Sequelize where on zones
 * @returns {Promise<{ currencySymbol: string, currencyCode: string }>}
 */
async function sharedCurrencyOfZones(where) {
    const { zone } = require('../models');
    const rows = await zone.findAll({
        where,
        attributes: ['id', 'currencyUnitId'],
        include: [currencyUnitInclude()],
        order: [['id', 'ASC']],
    });
    if (!rows.length) return empty();
    let shared = null;
    for (const row of rows) {
        const c = fromUnit(row.currencyUnitZ);
        if (!c) return empty();
        if (!shared) shared = c;
        else if (shared.currencyCode !== c.currencyCode) return empty();
    }
    return { ...shared };
}

/**
 * One zone's currency (soft-deleted zones included: historic bookings keep the currency
 * they were priced in). EMPTY when zoneId is missing or names no zone — never another
 * zone's currency.
 * @returns {Promise<{ currencySymbol: string, currencyCode: string }>}
 */
async function currencyOfZone(zoneId) {
    const id = parsePositiveInt(zoneId);
    if (!id) return empty();
    const { zone } = require('../models');
    const z = await zone.findByPk(id, {
        attributes: ['id', 'currencyUnitId'],
        include: [currencyUnitInclude()],
        paranoid: false,
    });
    return fromUnit(z?.currencyUnitZ) || empty();
}

/**
 * A stored ISO code (a ledger row's own currency) → `{ currencySymbol, currencyCode }`,
 * the symbol taken from its units row. A code with no units row displays as the code
 * itself (still the record's own data); no code → EMPTY.
 * @returns {Promise<{ currencySymbol: string, currencyCode: string }>}
 */
async function currencyOfCode(code) {
    const currencyCode = trimmed(code).toUpperCase();
    if (!currencyCode) return empty();
    const { units } = require('../models');
    const unit = await units.findOne({
        where: { type: 'currency', name: currencyCode },
        attributes: ['id', 'name', 'symbol'],
        order: [['id', 'ASC']],
    });
    return fromUnit(unit) || { currencySymbol: currencyCode, currencyCode };
}

/**
 * Currency to label an admin view filtered by zone / city / country (or unfiltered).
 * @param {object} filters - { zoneId, cityId, countryId } (the most specific one wins)
 * @returns {Promise<{ currencySymbol: string, currencyCode: string }>}
 */
async function resolveDisplayCurrency(filters = {}) {
    const { cities } = require('../models');

    if (parsePositiveInt(filters.zoneId)) return currencyOfZone(filters.zoneId);

    const cityId = parsePositiveInt(filters.cityId);
    if (cityId) {
        return sharedCurrencyOfZones({ cityId, status: true });
    }

    const countryId = parsePositiveInt(filters.countryId);
    if (countryId) {
        const cityRows = await cities.findAll({ where: { countryId }, attributes: ['id'] });
        const cityIds = cityRows.map((c) => c.id);
        if (!cityIds.length) return empty();
        return sharedCurrencyOfZones({ cityId: { [Op.in]: cityIds }, status: true });
    }

    return sharedCurrencyOfZones({ status: true });
}

module.exports = {
    EMPTY,
    fromUnit,
    currencyOfZone,
    currencyOfCode,
    resolveDisplayCurrency,
    sharedCurrencyOfZones,
};
