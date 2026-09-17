'use strict';

/**
 * Pure (DB-free) list-contract builders for admin list endpoints (LAUN-162).
 *
 * Services keep their own base scoping (zone, status, queue predicates) and call
 * these helpers to layer the shared `search / startDate / endDate / page / limit /
 * sortBy / sortDir / export` contract from utils/listQuery on top. Keeping the
 * builders here (not in the services, which require ../models) lets them be
 * unit-tested with plain node.
 *
 * Only parameterised Sequelize operators are produced (Op.like with escaped
 * wildcards, exact id matches). No user input is ever interpolated into SQL.
 */

const { Op, fn, col, where: sqlWhere } = require('sequelize');
const {
    parseSearchTerm,
    escapeLike,
    buildSearchWhere,
    andWhere,
    buildDateRangeWhere,
    applyListQueryInMemory,
} = require('./listQuery');
const { parseZoneId } = require('./adminZoneScope');

// ─── Action required feed (merged in JS) ─────────────────────────────────────

/** Default page size for `GET admin/action-required-orders`. */
const ACTION_REQUIRED_DEFAULT_LIMIT = 25;

/**
 * Shop name as carried on a mapped action-required row (`laundryShop` is the
 * addressDb row with its hasMany `bussinessInformations`).
 */
function actionRequiredShopName(row) {
    const shop = row?.laundryShop;
    if (!shop) return null;
    return (
        shop.name ||
        shop.bussinessInformation?.shopName ||
        shop.bussinessInformations?.[0]?.shopName ||
        null
    );
}

const toDate = (value) => (value ? new Date(value) : null);

/**
 * In-memory list options for the merged feed (search → sort → page/export).
 * Rows are the service's mapRow() shape.
 */
const ACTION_REQUIRED_LIST_OPTIONS = Object.freeze({
    searchFields: [
        'orderTrackId',
        'id',
        (row) => row.customer?.name,
        (row) => row.customer?.email,
        (row) => row.customer?.phoneNum,
        actionRequiredShopName,
        'zoneName',
    ],
    sortable: {
        // Default: priority ASC. Input is pre-sorted (priority, updatedAt DESC) and
        // Array.prototype.sort is stable, so ties keep the updatedAt order.
        priority: (row) => Number(row.priority ?? 99),
        updatedAt: (row) => toDate(row.updatedAt),
        createdAt: (row) => toDate(row.createdAt),
        collectionDate: (row) => toDate(row.collectionDate),
        deliveryDate: (row) => toDate(row.deliveryDate),
        orderAmount: (row) => Number(row.orderAmount || 0),
        lastPaymentFailureAt: (row) => toDate(row.lastPaymentFailureAt),
    },
    defaultSort: { sortBy: 'priority', sortDir: 'ASC' },
    defaultLimit: ACTION_REQUIRED_DEFAULT_LIMIT,
});

/**
 * Apply the shared list contract to already reason/zone/date-filtered feed rows.
 * @param {object[]} rows
 * @param {Record<string, unknown>} query req.query-like
 * @returns {{ rows: object[], pagination: object, search: string }}
 */
function applyActionRequiredListQuery(rows, query = {}) {
    return applyListQueryInMemory(rows, query, ACTION_REQUIRED_LIST_OPTIONS);
}

// ─── Payment failures (SQL) ──────────────────────────────────────────────────

/** Default page size for `GET admin/payment-failures`. */
const PAYMENT_FAILURE_DEFAULT_LIMIT = 25;

/** Column the failures queue sorts by and the `startDate/endDate` range applies to. */
const PAYMENT_FAILURE_DATE_COLUMN = 'lastPaymentFailureAt';

/**
 * Full-name match for "Jane Doe" style terms against an aliased customer include.
 * @param {string} alias include alias (e.g. "customer")
 * @param {string} term normalised search term
 */
function fullNameLike(alias, term) {
    return sqlWhere(
        fn('CONCAT_WS', ' ', col(`${alias}.firstName`), col(`${alias}.lastName`)),
        { [Op.like]: `%${escapeLike(term)}%` }
    );
}

/**
 * Layer zone / failure-date range / search onto the payment-failures base where.
 * Search: orderTrackId, booking id (numeric), customer first/last/full name,
 * email, phone. Requires the `customer` include on the query.
 *
 * @param {object} baseWhere queue predicate (never widened)
 * @param {Record<string, unknown>} query req.query-like (search, startDate, endDate)
 * @param {{ zoneId?: unknown }} [scope] resolved via zoneIdFromRequest
 * @returns {{ where: object, searchTerm: string, zoneId: number|null, hasSearch: boolean }}
 */
function buildPaymentFailureListWhere(baseWhere, query = {}, scope = {}) {
    let where = { ...(baseWhere || {}) };

    const zoneId = parseZoneId(scope.zoneId);
    if (zoneId) where.zoneId = zoneId;

    const range = buildDateRangeWhere(query.startDate, query.endDate);
    if (range) where[PAYMENT_FAILURE_DATE_COLUMN] = range;

    const searchTerm = parseSearchTerm(query.search);
    const searchWhere = buildSearchWhere(
        searchTerm,
        [
            'orderTrackId',
            '$customer.firstName$',
            '$customer.lastName$',
            '$customer.email$',
            '$customer.phoneNum$',
        ],
        { idFields: ['id'] }
    );
    if (searchWhere && searchTerm.includes(' ')) {
        searchWhere[Op.or].push(fullNameLike('customer', searchTerm));
    }
    where = andWhere(where, searchWhere);

    return { where, searchTerm, zoneId, hasSearch: Boolean(searchWhere) };
}

// ─── Policy lists (cancellation / no-show / reschedule) ──────────────────────

/** Default page size for the policy lists (unchanged legacy default). */
const POLICY_LIST_DEFAULT_LIMIT = 10;

/**
 * Search where for `policies` rows: name / description / zone name (via the
 * `zone` include) and exact id for numeric terms. Null when term is empty.
 * @param {unknown} rawTerm
 */
function buildPolicySearchWhere(rawTerm) {
    return buildSearchWhere(
        parseSearchTerm(rawTerm),
        ['name', 'description', '$zone.name$'],
        { idFields: ['id'] }
    );
}

// ─── Compliance events ───────────────────────────────────────────────────────

/** Default page size for `GET admin/compliance/events` (unchanged legacy default). */
const COMPLIANCE_EVENTS_DEFAULT_LIMIT = 20;

/**
 * Search where for agent_compliance_events: order track id (booking include),
 * driver name/email (`actor` include), shop owner name/email + shop name
 * (`shop` include → `businessInfo`), numeric term → bookingId.
 * @param {unknown} rawTerm
 */
function buildComplianceEventSearchWhere(rawTerm) {
    const term = parseSearchTerm(rawTerm);
    const searchWhere = buildSearchWhere(
        term,
        [
            '$booking.orderTrackId$',
            '$actor.firstName$',
            '$actor.lastName$',
            '$actor.email$',
            '$shop.firstName$',
            '$shop.lastName$',
            '$shop.email$',
            '$shop.businessInfo.shopName$',
        ],
        { idFields: ['bookingId'] }
    );
    if (searchWhere && term.includes(' ')) {
        searchWhere[Op.or].push(fullNameLike('actor', term));
        searchWhere[Op.or].push(fullNameLike('shop', term));
    }
    return searchWhere;
}

/**
 * Merge the shared `startDate/endDate` range into an existing `createdAt`
 * clause (legacy `from/to` stays supported by the caller).
 * @param {object} where
 * @param {Record<string, unknown>} query
 */
function mergeCreatedAtRange(where, query = {}) {
    const range = buildDateRangeWhere(query.startDate, query.endDate);
    if (!range) return where;
    return {
        ...where,
        createdAt: { ...(where.createdAt || {}), ...range },
    };
}

// ─── Agents with cash due (built in JS) ──────────────────────────────────────

/** Default page size for `GET admin/agents/cash-due` (unchanged legacy default). */
const CASH_DUE_DEFAULT_LIMIT = 20;

const CASH_DUE_LIST_OPTIONS = Object.freeze({
    searchFields: [
        'shopName',
        'agentName',
        'agentEmail',
        'agentPhone',
        'shopAddress',
        (row) => row.agentUserId,
        (row) => row.shopId,
    ],
    sortable: {
        cashDueToPlatform: (row) => Number(row.cashDueToPlatform || 0),
        shopName: (row) => row.shopName,
        agentName: (row) => row.agentName,
    },
    defaultSort: { sortBy: 'cashDueToPlatform', sortDir: 'DESC' },
    defaultLimit: CASH_DUE_DEFAULT_LIMIT,
});

/**
 * Apply the shared list contract to cash-due summary rows.
 * @param {object[]} rows
 * @param {Record<string, unknown>} query req.query-like
 */
function applyCashDueListQuery(rows, query = {}) {
    return applyListQueryInMemory(rows, query, CASH_DUE_LIST_OPTIONS);
}

module.exports = {
    ACTION_REQUIRED_DEFAULT_LIMIT,
    ACTION_REQUIRED_LIST_OPTIONS,
    actionRequiredShopName,
    applyActionRequiredListQuery,
    PAYMENT_FAILURE_DEFAULT_LIMIT,
    PAYMENT_FAILURE_DATE_COLUMN,
    buildPaymentFailureListWhere,
    POLICY_LIST_DEFAULT_LIMIT,
    buildPolicySearchWhere,
    COMPLIANCE_EVENTS_DEFAULT_LIMIT,
    buildComplianceEventSearchWhere,
    mergeCreatedAtRange,
    CASH_DUE_DEFAULT_LIMIT,
    CASH_DUE_LIST_OPTIONS,
    applyCashDueListQuery,
};
