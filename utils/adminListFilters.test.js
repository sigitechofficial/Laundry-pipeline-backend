'use strict';

const assert = require('assert/strict');
const { Op } = require('sequelize');
const { EXPORT_MAX_ROWS } = require('./listQuery');
const {
    ACTION_REQUIRED_DEFAULT_LIMIT,
    actionRequiredShopName,
    applyActionRequiredListQuery,
    PAYMENT_FAILURE_DEFAULT_LIMIT,
    PAYMENT_FAILURE_DATE_COLUMN,
    buildPaymentFailureListWhere,
    buildPolicySearchWhere,
    buildComplianceEventSearchWhere,
    mergeCreatedAtRange,
    CASH_DUE_DEFAULT_LIMIT,
    applyCashDueListQuery,
} = require('./adminListFilters');

// ─── action required (in-memory) ─────────────────────────────────────────────

assert.equal(ACTION_REQUIRED_DEFAULT_LIMIT, 25);

assert.equal(actionRequiredShopName(null), null);
assert.equal(actionRequiredShopName({ laundryShop: null }), null);
assert.equal(
    actionRequiredShopName({ laundryShop: { bussinessInformations: [{ shopName: 'Bubbles' }] } }),
    'Bubbles'
);
assert.equal(
    actionRequiredShopName({ laundryShop: { bussinessInformation: { shopName: 'Suds' } } }),
    'Suds'
);

const feed = [
    {
        id: 10, orderTrackId: '10-AB', priority: 3, updatedAt: new Date('2026-01-03'),
        customer: { name: 'Jane Doe', email: 'jane@x.io', phoneNum: '07700' },
        laundryShop: { bussinessInformations: [{ shopName: 'Bubbles' }] }, zoneName: 'North',
    },
    {
        id: 11, orderTrackId: '11-CD', priority: 1, updatedAt: new Date('2026-01-02'),
        customer: { name: 'Bob Ray', email: 'bob@x.io', phoneNum: '07711' },
        laundryShop: null, zoneName: 'South',
    },
    {
        id: 12, orderTrackId: '12-EF', priority: 1, updatedAt: new Date('2026-01-05'),
        customer: { name: 'Amy Lee', email: 'amy@x.io', phoneNum: '07722' },
        laundryShop: { bussinessInformations: [{ shopName: 'Suds' }] }, zoneName: 'North',
    },
];
// service pre-sorts by (priority ASC, updatedAt DESC)
const preSorted = [feed[2], feed[1], feed[0]];

let out = applyActionRequiredListQuery(preSorted, {});
assert.deepEqual(out.rows.map((r) => r.id), [12, 11, 10], 'default keeps priority/updatedAt order');
assert.equal(out.pagination.recordsPerPage, 25);
assert.equal(out.pagination.totalRecords, 3);
assert.equal(out.pagination.exportMode, false);

out = applyActionRequiredListQuery(preSorted, { search: 'bubbles' });
assert.deepEqual(out.rows.map((r) => r.id), [10], 'search hits shop name');
out = applyActionRequiredListQuery(preSorted, { search: '#11-CD' });
assert.deepEqual(out.rows.map((r) => r.id), [11], 'search hits orderTrackId, # stripped');
out = applyActionRequiredListQuery(preSorted, { search: 'bob@x.io' });
assert.deepEqual(out.rows.map((r) => r.id), [11], 'search hits customer email');
out = applyActionRequiredListQuery(preSorted, { search: '07722' });
assert.deepEqual(out.rows.map((r) => r.id), [12], 'search hits customer phone');
out = applyActionRequiredListQuery(preSorted, { search: 'south' });
assert.deepEqual(out.rows.map((r) => r.id), [11], 'search hits zone name');

out = applyActionRequiredListQuery(preSorted, { sortBy: 'updatedAt', sortDir: 'asc' });
assert.deepEqual(out.rows.map((r) => r.id), [11, 10, 12]);
out = applyActionRequiredListQuery(preSorted, { sortBy: 'password', sortDir: 'asc' });
assert.deepEqual(out.rows.map((r) => r.id), [12, 11, 10], 'unknown sortBy falls back');

out = applyActionRequiredListQuery(preSorted, { page: '2', limit: '2' });
assert.deepEqual(out.rows.map((r) => r.id), [10]);
assert.equal(out.pagination.currentPage, 2);
assert.equal(out.pagination.totalPages, 2);
assert.equal(out.pagination.hasPrevPage, true);

out = applyActionRequiredListQuery(preSorted, { page: '2', limit: '1', export: '1' });
assert.equal(out.rows.length, 3, 'export ignores page/limit');
assert.equal(out.pagination.exportMode, true);
assert.equal(out.pagination.recordsPerPage, EXPORT_MAX_ROWS);
assert.equal(out.pagination.truncated, false);

// ─── payment failures (SQL where) ────────────────────────────────────────────

assert.equal(PAYMENT_FAILURE_DEFAULT_LIMIT, 25);
assert.equal(PAYMENT_FAILURE_DATE_COLUMN, 'lastPaymentFailureAt');

const base = { paymentType: 'card', paymentDeliveryGate: 'waiting_admin' };
let pf = buildPaymentFailureListWhere(base, {});
assert.deepEqual(pf.where, base, 'no filters → base where untouched');
assert.equal(pf.hasSearch, false);
assert.equal(pf.zoneId, null);
assert.notEqual(pf.where, base, 'base object is not mutated');

pf = buildPaymentFailureListWhere(base, { startDate: '2026-02-01', endDate: '2026-02-28' }, { zoneId: '7' });
assert.equal(pf.where.paymentType, 'card', 'queue predicate kept');
assert.equal(pf.where.zoneId, 7);
assert.ok(pf.where.lastPaymentFailureAt[Op.gte] instanceof Date);
assert.equal(pf.where.lastPaymentFailureAt[Op.lte].getHours(), 23);

pf = buildPaymentFailureListWhere(base, { search: ' 42 ' });
assert.equal(pf.hasSearch, true);
assert.equal(pf.searchTerm, '42');
const pfOr = pf.where[Op.and][0][Op.or];
assert.deepEqual(pfOr[0], { orderTrackId: { [Op.like]: '%42%' } });
assert.ok(pfOr.some((c) => c['$customer.email$']));
assert.ok(pfOr.some((c) => c['$customer.phoneNum$']));
assert.deepEqual(pfOr[pfOr.length - 1], { id: 42 }, 'numeric term → booking id');
assert.equal(pf.where.paymentType, 'card', 'search never drops queue predicate');

pf = buildPaymentFailureListWhere(base, { search: '50%_off' });
assert.deepEqual(pf.where[Op.and][0][Op.or][0], { orderTrackId: { [Op.like]: '%50\\%\\_off%' } });

pf = buildPaymentFailureListWhere(base, { search: 'Jane Doe' });
const pfNameOr = pf.where[Op.and][0][Op.or];
assert.ok(!pfNameOr.some((c) => c.id !== undefined), 'text term → no id match');
assert.ok(
    pfNameOr[pfNameOr.length - 1] && typeof pfNameOr[pfNameOr.length - 1] === 'object'
        && pfNameOr[pfNameOr.length - 1].attribute,
    'two-word term adds CONCAT_WS full-name clause'
);

pf = buildPaymentFailureListWhere(base, { search: 'x' }, { zoneId: 'abc' });
assert.equal(pf.where.zoneId, undefined, 'invalid zoneId is ignored, not widened');

// ─── policies ────────────────────────────────────────────────────────────────

assert.equal(buildPolicySearchWhere(''), null);
assert.equal(buildPolicySearchWhere(undefined), null);
const pol = buildPolicySearchWhere('North');
assert.deepEqual(pol[Op.or], [
    { name: { [Op.like]: '%North%' } },
    { description: { [Op.like]: '%North%' } },
    { '$zone.name$': { [Op.like]: '%North%' } },
]);
assert.deepEqual(buildPolicySearchWhere('3')[Op.or].pop(), { id: 3 });

// ─── compliance events ───────────────────────────────────────────────────────

assert.equal(buildComplianceEventSearchWhere('  '), null);
const ce = buildComplianceEventSearchWhere('12-AB');
const ceKeys = ce[Op.or].map((c) => Object.keys(c)[0]);
assert.ok(ceKeys.includes('$booking.orderTrackId$'));
assert.ok(ceKeys.includes('$actor.firstName$'));
assert.ok(ceKeys.includes('$shop.businessInfo.shopName$'));
assert.ok(!ceKeys.includes('bookingId'), 'non-numeric → no bookingId match');
assert.deepEqual(buildComplianceEventSearchWhere('88')[Op.or].pop(), { bookingId: 88 });
const ceName = buildComplianceEventSearchWhere('Sam Smith');
assert.equal(ceName[Op.or].filter((c) => c.attribute).length, 2, 'actor + shop full-name clauses');

assert.deepEqual(mergeCreatedAtRange({ shopId: 1 }, {}), { shopId: 1 });
const merged = mergeCreatedAtRange(
    { shopId: 1, createdAt: { [Op.gte]: new Date('2026-01-01') } },
    { endDate: '2026-01-31' }
);
assert.equal(merged.shopId, 1);
assert.ok(merged.createdAt[Op.gte] instanceof Date, 'legacy from bound preserved');
assert.equal(merged.createdAt[Op.lte].getHours(), 23, 'endDate bound added');

// ─── cash due (in-memory) ────────────────────────────────────────────────────

assert.equal(CASH_DUE_DEFAULT_LIMIT, 20);
const agents = [
    { agentUserId: 1, shopId: 5, shopName: 'Bubbles', agentName: 'Jane Doe', agentEmail: 'jane@x.io', agentPhone: '0770', cashDueToPlatform: 50 },
    { agentUserId: 2, shopId: 6, shopName: 'Suds', agentName: 'Bob Ray', agentEmail: 'bob@x.io', agentPhone: '0771', cashDueToPlatform: 120 },
    { agentUserId: 3, shopId: 7, shopName: 'Clean Co', agentName: 'Amy Lee', agentEmail: 'amy@x.io', agentPhone: '0772', cashDueToPlatform: 0 },
];
let cd = applyCashDueListQuery(agents, {});
assert.deepEqual(cd.rows.map((r) => r.agentUserId), [2, 1, 3], 'default cashDue DESC');
assert.equal(cd.pagination.recordsPerPage, 20);
cd = applyCashDueListQuery(agents, { search: 'suds' });
assert.deepEqual(cd.rows.map((r) => r.agentUserId), [2]);
cd = applyCashDueListQuery(agents, { search: 'amy@x.io' });
assert.deepEqual(cd.rows.map((r) => r.agentUserId), [3]);
cd = applyCashDueListQuery(agents, { search: '0771' });
assert.deepEqual(cd.rows.map((r) => r.agentUserId), [2], 'phone search');
cd = applyCashDueListQuery(agents, { sortBy: 'shopName', sortDir: 'asc' });
assert.deepEqual(cd.rows.map((r) => r.shopName), ['Bubbles', 'Clean Co', 'Suds']);
cd = applyCashDueListQuery(agents, { export: 'csv', limit: '1' });
assert.equal(cd.rows.length, 3);
assert.equal(cd.pagination.exportMode, true);

console.log('adminListFilters tests passed');
