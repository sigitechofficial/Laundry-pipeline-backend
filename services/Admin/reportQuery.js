'use strict';

const { Op } = require('sequelize');
const { clampListLimit, clampPage } = require('../../utils/listLimit');
const { resolveDisplayCurrency } = require('../../utils/resolveDisplayCurrency');
const {
    COMPLETED,
    CANCELLED,
    ON_HOLD,
} = require('../../constants/bookingStatusIds');

const ALLOWED_PERIODS = new Set(['today', 'this_week', 'this_month', 'custom', 'all']);
const REVENUE_STATUSES = [16, COMPLETED];
const REFUNDED = 21;
const EXCLUDED_FROM_ACTIVITY = [CANCELLED, REFUNDED];

function parsePositiveInt(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDateOnly(value) {
    const raw = value == null ? '' : String(value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function parseSearch(value) {
    const raw = value == null ? '' : String(value).trim();
    if (!raw) return '';
    return raw.slice(0, 80);
}

function parseFilters(raw = {}) {
    const period = ALLOWED_PERIODS.has(raw.period) ? raw.period : 'all';
    const startDate = period === 'custom' ? parseDateOnly(raw.startDate) : '';
    const endDate = period === 'custom' ? parseDateOnly(raw.endDate) : '';
    const page = clampPage(raw.page);
    const limit = clampListLimit(raw.limit, 20, 100);

    return {
        period,
        startDate,
        endDate,
        zoneId: parsePositiveInt(raw.zoneId),
        cityId: parsePositiveInt(raw.cityId),
        countryId: parsePositiveInt(raw.countryId),
        shopId: parsePositiveInt(raw.shopId),
        search: parseSearch(raw.search),
        page,
        limit,
    };
}

function buildPeriodRange(period, startDate, endDate) {
    const now = new Date();

    if (period === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        return { start, end };
    }

    if (period === 'this_week') {
        const start = new Date(now);
        start.setDate(now.getDate() - 6);
        start.setHours(0, 0, 0, 0);
        return { start, end: now };
    }

    if (period === 'this_month') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start, end: now };
    }

    if (period === 'custom' && startDate && endDate) {
        return {
            start: new Date(`${startDate}T00:00:00`),
            end: new Date(`${endDate}T23:59:59`),
        };
    }

    return null;
}

function sqlDateTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildBookingWhere(filters = {}, extraWhere = {}) {
    const where = { ...extraWhere };
    const range = buildPeriodRange(filters.period, filters.startDate, filters.endDate);
    if (range) {
        where.collectionDate = { [Op.between]: [range.start, range.end] };
    }
    if (filters.zoneId) where.zoneId = filters.zoneId;
    if (filters.shopId) where.laundryShopId = filters.shopId;
    return where;
}

/**
 * Parameterized booking filter fragments. Never interpolates client strings.
 * shopId is laundryShopId (address id).
 */
function buildSqlFragments(filters = {}, dateCol = 'b.collectionDate') {
    const parts = ['b.deletedAt IS NULL'];
    const replacements = {};

    if (filters.zoneId) {
        parts.push('b.zoneId = :zoneId');
        replacements.zoneId = filters.zoneId;
    }
    if (filters.shopId) {
        parts.push('b.laundryShopId = :shopId');
        replacements.shopId = filters.shopId;
    }

    const range = buildPeriodRange(filters.period, filters.startDate, filters.endDate);
    if (range) {
        parts.push(`${dateCol} BETWEEN :dateStart AND :dateEnd`);
        replacements.dateStart = sqlDateTime(range.start);
        replacements.dateEnd = sqlDateTime(range.end);
    }

    return { whereSql: parts.join(' AND '), replacements, range };
}

function paginate(filters = {}) {
    const page = clampPage(filters.page);
    const limit = clampListLimit(filters.limit, 20, 100);
    return { page, limit, offset: (page - 1) * limit };
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function asInt(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
}

async function resolveReportCurrency(filters = {}) {
    return resolveDisplayCurrency({
        zoneId: filters.zoneId,
        cityId: filters.cityId,
        countryId: filters.countryId,
    });
}

function envelope({ filters, data, total, page, limit, summary, currency, ...extra }) {
    return {
        data,
        total: total ?? (Array.isArray(data) ? data.length : 0),
        page: page || 1,
        limit: limit || (Array.isArray(data) ? data.length : 20),
        summary: summary || {},
        currency: currency || { currencySymbol: '', currencyCode: '' },
        filters,
        ...extra,
    };
}

module.exports = {
    parseFilters,
    buildPeriodRange,
    sqlDateTime,
    buildBookingWhere,
    buildSqlFragments,
    paginate,
    money,
    asInt,
    resolveReportCurrency,
    envelope,
    REVENUE_STATUSES,
    EXCLUDED_FROM_ACTIVITY,
    CANCELLED,
    ON_HOLD,
    REFUNDED,
    COMPLETED,
};
