'use strict';

/**
 * Allowlisted booking columns for admin order-list sort.
 * Never interpolate a client-supplied column into SQL — only these keys.
 *
 * Default (newest first): createdAt DESC, id DESC.
 * Lists previously used id DESC alone; createdAt + id matches "newest first"
 * when createdAt and id disagree (imports, backfills).
 *
 * bookingStatusId is pipeline order (numeric status id), not status title A–Z.
 * id is the numeric PK (Order ID). orderTrackId is `${id}-…` — string sort is
 * not allowlisted. Shop name is not allowlisted (associated join + LIMIT
 * would break pagination on the hasMany list includes).
 */

const ORDER_LIST_SORT_FIELDS = Object.freeze({
    id: 'id',
    createdAt: 'createdAt',
    totalItems: 'totalItems',
    collectionDate: 'collectionDate',
    deliveryDate: 'deliveryDate',
    bookingStatusId: 'bookingStatusId',
    updatedAt: 'updatedAt',
    orderAmount: 'orderAmount',
});

const PAYMENT_FAILURE_SORT_FIELDS = Object.freeze({
    ...ORDER_LIST_SORT_FIELDS,
    lastPaymentFailureAt: 'lastPaymentFailureAt',
});

const DEFAULT_ORDER_LIST_SORT = Object.freeze({
    sortBy: 'createdAt',
    sortDir: 'DESC',
});

const DEFAULT_PAYMENT_FAILURE_SORT = Object.freeze({
    sortBy: 'lastPaymentFailureAt',
    sortDir: 'DESC',
});

function normalizeSortDir(dir, fallback = DEFAULT_ORDER_LIST_SORT.sortDir) {
    const raw = String(dir || '').trim().toLowerCase();
    if (raw === 'asc') return 'ASC';
    if (raw === 'desc') return 'DESC';
    return fallback;
}

/**
 * @param {string} [sortBy]
 * @param {string} [sortDir]
 * @param {{ allowlist?: Record<string, string>, defaultSortBy?: string, defaultSortDir?: string }} [options]
 */
function resolveOrderListSort(sortBy, sortDir, options = {}) {
    const allowlist = options.allowlist || ORDER_LIST_SORT_FIELDS;
    const defaultSortBy = options.defaultSortBy || DEFAULT_ORDER_LIST_SORT.sortBy;
    const defaultSortDir = options.defaultSortDir || DEFAULT_ORDER_LIST_SORT.sortDir;
    const key = String(sortBy || '').trim();
    const known = Object.prototype.hasOwnProperty.call(allowlist, key);
    return {
        sortBy: known ? allowlist[key] : defaultSortBy,
        sortDir: known ? normalizeSortDir(sortDir, defaultSortDir) : defaultSortDir,
        known,
    };
}

/**
 * Sequelize `order` clause: allowlisted column + direction, then id DESC tie-break.
 * Unknown sortBy / sortDir → list default (createdAt DESC unless overridden).
 *
 * @returns {Array<[string, string]>}
 */
function buildOrderListSequelizeOrder(sortBy, sortDir, options = {}) {
    const resolved = resolveOrderListSort(sortBy, sortDir, options);
    const order = [[resolved.sortBy, resolved.sortDir]];
    if (resolved.sortBy !== 'id') {
        order.push(['id', 'DESC']);
    }
    return order;
}

module.exports = {
    ORDER_LIST_SORT_FIELDS,
    PAYMENT_FAILURE_SORT_FIELDS,
    DEFAULT_ORDER_LIST_SORT,
    DEFAULT_PAYMENT_FAILURE_SORT,
    normalizeSortDir,
    resolveOrderListSort,
    buildOrderListSequelizeOrder,
};
