'use strict';

const assert = require('assert/strict');
const { Op } = require('sequelize');
const {
    EXPORT_MAX_ROWS,
    isExportRequest,
    parseSearchTerm,
    escapeLike,
    buildSearchWhere,
    andWhere,
    buildDateRangeWhere,
    resolveListWindow,
    resolveSort,
    buildPagination,
    applyListQueryInMemory,
} = require('./listQuery');

// isExportRequest
assert.equal(isExportRequest({}), false);
assert.equal(isExportRequest({ export: '1' }), true);
assert.equal(isExportRequest({ export: 'true' }), true);
assert.equal(isExportRequest({ format: 'csv' }), true);
assert.equal(isExportRequest({ export: '0' }), false);

// parseSearchTerm
assert.equal(parseSearchTerm(undefined), '');
assert.equal(parseSearchTerm('   '), '');
assert.equal(parseSearchTerm('  #LDR-12  '), 'LDR-12');
assert.equal(parseSearchTerm('x'.repeat(500)).length, 120);

// escapeLike
assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');

// buildSearchWhere
assert.equal(buildSearchWhere('', ['email']), null);
const sw = buildSearchWhere('42', ['email', '$zone.zoneName$'], { idFields: ['id'] });
assert.equal(sw[Op.or].length, 3);
assert.deepEqual(sw[Op.or][0], { email: { [Op.like]: '%42%' } });
assert.deepEqual(sw[Op.or][2], { id: 42 });
const swText = buildSearchWhere('bob', ['email'], { idFields: ['id'] });
assert.equal(swText[Op.or].length, 1, 'non-numeric term must not add id match');

// andWhere
assert.deepEqual(andWhere({}, null), {});
assert.equal(andWhere({}, sw), sw);
const merged = andWhere({ userTypeId: 2 }, sw);
assert.equal(merged.userTypeId, 2);
assert.equal(merged[Op.and].length, 1);
const merged2 = andWhere({ userTypeId: 2, [Op.and]: [{ a: 1 }] }, sw);
assert.equal(merged2[Op.and].length, 2);

// buildDateRangeWhere
assert.equal(buildDateRangeWhere(undefined, undefined), null);
assert.equal(buildDateRangeWhere('nope', 'nah'), null);
const range = buildDateRangeWhere('2026-01-01', '2026-01-31');
assert.equal(range[Op.gte].getHours(), 0);
assert.equal(range[Op.lte].getHours(), 23);
assert.equal(range[Op.lte].getMilliseconds(), 999);
const openEnded = buildDateRangeWhere('2026-01-01', undefined);
assert.ok(openEnded[Op.gte] instanceof Date);
assert.equal(openEnded[Op.lte], undefined);

// resolveListWindow
assert.deepEqual(resolveListWindow({}), { page: 1, limit: 20, offset: 0, exportMode: false });
assert.deepEqual(resolveListWindow({ page: '3', limit: '25' }), { page: 3, limit: 25, offset: 50, exportMode: false });
assert.deepEqual(resolveListWindow({ page: '3', limit: '9999' }), { page: 3, limit: 100, offset: 200, exportMode: false });
assert.deepEqual(resolveListWindow({ page: '7', limit: '10', export: '1' }), {
    page: 1,
    limit: EXPORT_MAX_ROWS,
    offset: 0,
    exportMode: true,
});
assert.equal(resolveListWindow({ export: 'csv' }, { exportMax: 250 }).limit, 250);

// resolveSort
const sort = resolveSort({ sortBy: 'email', sortDir: 'asc' }, { email: 'email', name: 'firstName' }, { sortBy: 'createdAt' });
assert.deepEqual(sort, { sortBy: 'email', sortDir: 'ASC', order: [['email', 'ASC']] });
const badSort = resolveSort({ sortBy: 'password', sortDir: 'sideways' }, { email: 'email' }, { sortBy: 'createdAt' });
assert.deepEqual(badSort, { sortBy: 'createdAt', sortDir: 'DESC', order: [['createdAt', 'DESC']] });

// buildPagination
assert.deepEqual(buildPagination(0, { page: 1, limit: 20, exportMode: false }), {
    currentPage: 1, totalPages: 1, totalRecords: 0, recordsPerPage: 20,
    hasNextPage: false, hasPrevPage: false, exportMode: false, truncated: false,
});
assert.deepEqual(buildPagination(45, { page: 2, limit: 20, exportMode: false }), {
    currentPage: 2, totalPages: 3, totalRecords: 45, recordsPerPage: 20,
    hasNextPage: true, hasPrevPage: true, exportMode: false, truncated: false,
});
const exp = buildPagination(6000, { page: 1, limit: EXPORT_MAX_ROWS, exportMode: true });
assert.equal(exp.exportMode, true);
assert.equal(exp.truncated, true);
assert.equal(buildPagination(10, { page: 1, limit: EXPORT_MAX_ROWS, exportMode: true }).truncated, false);

// applyListQueryInMemory
const people = [
    { id: 1, name: 'Zed', city: 'Leeds', createdAt: new Date('2026-01-03') },
    { id: 2, name: 'Amy', city: 'London', createdAt: new Date('2026-01-01') },
    { id: 3, name: 'Bob', city: 'Leeds', createdAt: new Date('2026-01-02') },
];
const opts = {
    searchFields: ['name', (r) => r.city],
    sortable: { name: (r) => r.name, createdAt: (r) => r.createdAt },
    defaultSort: { sortBy: 'createdAt', sortDir: 'DESC' },
};
let out = applyListQueryInMemory(people, {}, opts);
assert.deepEqual(out.rows.map((r) => r.id), [1, 3, 2], 'default sort newest first');
assert.equal(out.pagination.totalRecords, 3);

out = applyListQueryInMemory(people, { search: 'leeds' }, opts);
assert.deepEqual(out.rows.map((r) => r.id), [1, 3]);
assert.equal(out.search, 'leeds');

out = applyListQueryInMemory(people, { sortBy: 'name', sortDir: 'asc', page: '2', limit: '2' }, opts);
assert.deepEqual(out.rows.map((r) => r.name), ['Zed']);
assert.equal(out.pagination.currentPage, 2);
assert.equal(out.pagination.totalPages, 2);

out = applyListQueryInMemory(people, { export: '1', limit: '1' }, opts);
assert.equal(out.rows.length, 3, 'export ignores limit');
assert.equal(out.pagination.exportMode, true);

console.log('listQuery tests passed');
