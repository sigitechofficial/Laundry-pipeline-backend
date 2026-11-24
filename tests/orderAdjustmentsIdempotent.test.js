'use strict';

/**
 * redemptionService.writeOrderAdjustments runs on every invoice open (bookingPromotionService
 * .priceAtInvoice). When the stored system promotion adjustments already are exactly the
 * priced ones it keeps them; otherwise it replaces them, as before.
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

let stored = [];
const ops = [];
let nextId = 1;
const OrderAdjustment = {
    findAll: async (opts) => {
        ops.push('findAll');
        assert.ok(opts.lock, 'existing rows are read under the transaction lock');
        return stored.map((r) => ({ ...r }));
    },
    destroy: async () => { ops.push('destroy'); stored = []; },
    create: async (row) => { ops.push('create'); const r = { id: nextId++, ...row }; stored.push(r); return r; },
};
const fakeModels = new Proxy(
    {
        orderAdjustment: OrderAdjustment,
        sequelize: { transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    },
    { get: (t, p) => (p in t ? t[p] : {}) }
);
const modelsPath = path.resolve(__dirname, '../models');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && parent.filename && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        if (resolved === modelsPath) return fakeModels;
    }
    return originalLoad.apply(this, arguments);
};

const { writeOrderAdjustments } = require('../services/promotions/redemptionService');

const priced = (amountMinor, lineItemId = 77) => [{
    promotionId: 5,
    promotionVersionId: 2,
    promotionName: '10% off',
    benefitType: 'item_discount',
    couponCodeId: null,
    couponCode: null,
    adjustments: [
        { lineType: 'subCategory', lineItemId, amountMinor: -amountMinor, label: 'Shirts' },
        { lineType: 'basket', lineItemId: null, amountMinor: 0 }, // nothing off: not stored
    ],
}];

(async () => {
    const opts = { currency: 'GBP' };

    // First pricing writes the rows.
    await writeOrderAdjustments(900, priced(150), opts);
    assert.deepStrictEqual(ops, ['findAll', 'destroy', 'create']);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(Number(stored[0].amount), -1.5);
    const firstId = stored[0].id;

    // Same pricing again (every invoice open): no delete, no insert, same row kept.
    ops.length = 0;
    const kept = await writeOrderAdjustments(900, priced(150), opts);
    assert.deepStrictEqual(ops, ['findAll']);
    assert.strictEqual(kept[0].id, firstId);

    // Read back from the database: DECIMAL as a number, ids as strings — still the same.
    stored[0].amount = -1.5; // DECIMAL read back as a number (decimalNumbers)
    stored[0].promotionId = '5';
    ops.length = 0;
    await writeOrderAdjustments(900, priced(150), opts);
    assert.deepStrictEqual(ops, ['findAll']);

    // Different amount, line or currency: replaced.
    for (const [label, args] of [['amount', [priced(200), opts]], ['line', [priced(150, 78), opts]], ['currency', [priced(150), { currency: 'USD' }]]]) {
        await writeOrderAdjustments(900, priced(150), opts);
        ops.length = 0;
        await writeOrderAdjustments(900, ...args);
        assert.deepStrictEqual(ops, ['findAll', 'destroy', 'create'], `${label} change is written`);
    }

    // Nothing priced any more: the stored rows are removed; nothing stored, nothing priced: no write.
    ops.length = 0;
    await writeOrderAdjustments(900, [], opts);
    assert.deepStrictEqual(ops, ['findAll', 'destroy']);
    assert.strictEqual(stored.length, 0);
    ops.length = 0;
    await writeOrderAdjustments(900, [], opts);
    assert.deepStrictEqual(ops, ['findAll']);

    console.log('orderAdjustmentsIdempotent tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
