'use strict';

/**
 * GET /agent/serviceDetail builds the shop's catalog for every service it offers. These
 * tests pin the query budget of the two loaders it uses (no DB: models are stubbed and
 * every findAll is counted):
 *  - serviceManagementService.getServiceCategoriesDataForServices: 2 queries for any
 *    number of services, and per service the same rows as getServiceCategoriesDataForService;
 *  - zoneCatalogService.loadServiceCategoriesOverlay: the zone overlay read once, then
 *    applyToServiceCategoriesData(…, overlay) for each service reads nothing more, and an
 *    overlay is never applied to another zone.
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const calls = [];
function model(name, rowsFor = () => []) {
    return {
        name,
        findAll: async (opts = {}) => {
            calls.push(name);
            return rowsFor(opts);
        },
    };
}
const instance = (plain) => ({ ...plain, toJSON: () => JSON.parse(JSON.stringify(plain)) });
const sub = (id, sortOrder) => ({ id, name: `Item ${id}`, price: '2.50', status: true, description: null, unitCount: 1, sortOrder });

// Catalog: service 1 has direct categories 10, 11 and junction category 30 (shared with
// service 2); service 2 has direct category 20 and junction 30; service 3 has nothing.
const directCategories = [
    { id: 10, name: 'Shirts', description: null, serviceId: 1, sortOrder: 2, subCategories: [sub(101, 2), sub(100, 1)] },
    { id: 20, name: 'Duvets', description: null, serviceId: 2, sortOrder: 1, subCategories: [sub(200, 0)] },
    { id: 11, name: 'Suits', description: null, serviceId: 1, sortOrder: 1, subCategories: [] },
];
const junctions = [
    { id: 501, serviceId: 1, status: true, category: { id: 30, name: 'Shared', description: null, serviceId: null, sortOrder: 3, subCategories: [sub(300, 0)] } },
    { id: 502, serviceId: 2, status: true, category: { id: 30, name: 'Shared', description: null, serviceId: null, sortOrder: 3, subCategories: [sub(300, 0)] } },
    // Junction pointing at service 1's own direct category: must not duplicate it.
    { id: 503, serviceId: 1, status: true, category: { id: 10, name: 'Shirts', description: null, serviceId: 1, sortOrder: 2, subCategories: [] } },
];
const idsOf = (where) => [].concat(where.serviceId).map(Number);

const fakeModels = new Proxy(
    {
        categories: model('categories', ({ where }) =>
            directCategories.filter((c) => idsOf(where).includes(c.serviceId)).map(instance)),
        serviceCategories: model('serviceCategories', ({ where }) =>
            junctions.filter((j) => idsOf(where).includes(j.serviceId)).map((j) => ({
                ...j,
                category: instance(j.category),
            }))),
        serviceDiscount: model('serviceDiscount'),
        service: model('service', () => [
            { id: 1, name: 'Wash' },
            { id: 2, name: 'Dry clean' },
            { id: 3, name: 'Alterations' },
        ]),
        customerSelectedService: {
            count: async (opts = {}) => {
                calls.push('customerSelectedService.count');
                assert.deepStrictEqual(opts.group, ['serviceId']);
                return [{ serviceId: 1, count: 4 }, { serviceId: 3, count: 1 }];
            },
        },
    },
    {
        get(target, prop) {
            if (!(prop in target)) target[prop] = model(String(prop));
            return target[prop];
        },
    }
);

const modelsPath = path.resolve(__dirname, '../models');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && parent.filename && !parent.filename.includes('node_modules')) {
        const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request) : request;
        if (resolved === modelsPath || resolved === `${modelsPath}/index` || resolved === `${modelsPath}/index.js`) {
            return fakeModels;
        }
        if (resolved === path.resolve(__dirname, '../services/Admin/runtimeSettingsService')) {
            return { getBoolean: async () => { calls.push('runtimeSetting'); return true; } };
        }
    }
    return originalLoad.apply(this, arguments);
};

const serviceManagementService = require('../services/Admin/serviceManagementService');
const zoneCatalogService = require('../services/Admin/zoneCatalogService');

(async () => {
    // ── Batched category trees ────────────────────────────────────────────────
    calls.length = 0;
    const trees = await serviceManagementService.getServiceCategoriesDataForServices([1, 2, 3, '1']);
    assert.deepStrictEqual(calls.sort(), ['categories', 'serviceCategories'], 'two queries for three services');
    assert.deepStrictEqual([...trees.keys()], [1, 2, 3]);
    assert.deepStrictEqual(trees.get(3), []);

    const s1 = trees.get(1);
    assert.deepStrictEqual(s1.map((r) => r.categoryId), [11, 10, 30], 'sorted by category sortOrder, no duplicate of 10');
    assert.strictEqual(s1[1].id, 'svc-cat-10');
    assert.deepStrictEqual(s1[1].category.subCategories.map((s) => s.id), [100, 101], 'items sorted by sortOrder');
    assert.strictEqual(s1[2].id, 501);
    assert.deepStrictEqual(trees.get(2).map((r) => r.categoryId), [20, 30]);

    // The single-service API returns exactly the batched rows (same builder), 2 queries each.
    for (const id of [1, 2, 3]) {
        calls.length = 0;
        const single = await serviceManagementService.getServiceCategoriesDataForService(id);
        assert.deepStrictEqual(single, trees.get(id));
        assert.strictEqual(calls.length, 2);
    }
    await assert.rejects(() => serviceManagementService.getServiceCategoriesDataForService(0), /Valid serviceId/);
    calls.length = 0;
    assert.strictEqual((await serviceManagementService.getServiceCategoriesDataForServices([])).size, 0);
    assert.strictEqual(calls.length, 0, 'no query for no services');

    // ── getAllServices: usage counts in one GROUP BY ─────────────────────────
    calls.length = 0;
    const all = await serviceManagementService.getAllServices();
    assert.deepStrictEqual(calls, ['service', 'customerSelectedService.count']);
    assert.deepStrictEqual(all.servicesCount, { Wash: 4, 'Dry clean': 0, Alterations: 1 });

    // ── Zone overlay loaded once per request ──────────────────────────────────
    calls.length = 0;
    const overlay = await zoneCatalogService.loadServiceCategoriesOverlay(7);
    const overlayReads = calls.length;
    assert.strictEqual(calls.filter((c) => c === 'serviceDiscount').length, 1);
    assert.strictEqual(calls.filter((c) => /^zone/.test(c)).length, 9, 'nine override tables');
    assert.strictEqual(overlay.zoneId, 7);

    calls.length = 0;
    for (const id of [1, 2, 3]) {
        const applied = await zoneCatalogService.applyToServiceCategoriesData(trees.get(id), 7, id, overlay);
        assert.ok(Array.isArray(applied));
    }
    assert.deepStrictEqual(calls, [], 'no query per service once the overlay is loaded');

    // Without an overlay the function still loads its own (callers that pass none).
    calls.length = 0;
    const own = await zoneCatalogService.applyToServiceCategoriesData(trees.get(1), 7, 1);
    assert.strictEqual(calls.length, overlayReads);
    assert.deepStrictEqual(own, await zoneCatalogService.applyToServiceCategoriesData(trees.get(1), 7, 1, overlay));

    // An overlay is never applied to another zone.
    await assert.rejects(
        () => zoneCatalogService.applyToServiceCategoriesData(trees.get(1), 8, 1, overlay),
        /overlay of zone 7 used for zone 8/
    );
    const noZone = await zoneCatalogService.loadServiceCategoriesOverlay(null);
    assert.strictEqual(noZone.zoneId, null);
    assert.strictEqual(noZone.maps, null);
    await zoneCatalogService.applyToServiceCategoriesData(trees.get(1), '', 1, noZone);

    console.log('serviceCatalogBatchQueries tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
