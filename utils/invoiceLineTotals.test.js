'use strict';

const assert = require('assert');

// Isolate from live Sequelize / gitignored config.json (same pattern as checkPermission tests).
require('../tests/stubSequelizeModels').install();

const {
    getLineQuantity,
    getLineSubtotal,
    getSelectedServiceRowSubtotal,
    getAddOnRowSubtotal,
    normalizeAddOnEntriesFromService,
} = require('./invoiceLineTotals');

function runTests() {
    assert.strictEqual(getLineQuantity(2), 2);
    assert.strictEqual(getLineQuantity('2'), 2);
    assert.strictEqual(getLineQuantity(0), 1);
    assert.strictEqual(getLineQuantity(null), 1);

    assert.strictEqual(getLineSubtotal(2.95, 2), 5.9);
    assert.strictEqual(getLineSubtotal(7.95, 2), 15.9);
    assert.strictEqual(getLineSubtotal(15, 1), 15);

    assert.strictEqual(
        getSelectedServiceRowSubtotal({ categoryPrice: 2.95, items: 2 }),
        5.9
    );

    assert.strictEqual(getAddOnRowSubtotal({ price: 4, items: 2 }), 8);
    assert.strictEqual(getAddOnRowSubtotal({ price: 3, items: 1 }), 3);
    assert.strictEqual(getAddOnRowSubtotal({ price: 3 }), 3);

    const dupIds = normalizeAddOnEntriesFromService({
        addOnServiceIds: [10, 10, 9],
    });
    assert.deepStrictEqual(dupIds, [
        { addOnServiceId: 10, items: 2 },
        { addOnServiceId: 9, items: 1 },
    ]);

    const objectQty = normalizeAddOnEntriesFromService({
        addOns: [
            { addOnServiceId: 10, qty: 2 },
            { id: 9, quantity: 1 },
        ],
    });
    assert.deepStrictEqual(objectQty, [
        { addOnServiceId: 10, items: 2 },
        { addOnServiceId: 9, items: 1 },
    ]);

    const booking391StyleLines = [
        { categoryCharge: 15.0, items: 1 },
        { categoryCharge: 20.0, items: 1 },
        { categoryCharge: 15.0, items: 1 },
        { categoryCharge: 2.95, items: 2 },
        { categoryCharge: 7.95, items: 2 },
        { categoryCharge: 2.0, items: 1 },
        { categoryCharge: 2.0, items: 1 },
        { categoryCharge: 19.95, items: 1 },
    ];
    const servicesOnly = booking391StyleLines.reduce(
        (sum, line) => sum + getLineSubtotal(line.categoryCharge, line.items),
        0
    );
    assert.strictEqual(servicesOnly, 95.75);

    const withAddOns = servicesOnly + 4 + 3 + 5;
    assert.strictEqual(withAddOns, 107.75);

    const selection395Style = [
        { categoryCharge: 2.95, items: 2 },
        { categoryCharge: 7.95, items: 1 },
        { categoryCharge: 2.95, items: 1 },
        { categoryCharge: 7.95, items: 1 },
    ];
    const services395 = selection395Style.reduce(
        (sum, line) => sum + getLineSubtotal(line.categoryCharge, line.items),
        0
    );
    assert.strictEqual(services395, 24.75);

    const addons395 = getAddOnRowSubtotal({ price: 3, items: 1 })
        + getAddOnRowSubtotal({ price: 4, items: 2 })
        + getAddOnRowSubtotal({ price: 3, items: 2 });
    assert.strictEqual(addons395, 17);
    assert.strictEqual(services395 + addons395, 41.75);

    console.log('invoiceLineTotals.test.js: all assertions passed');
}

runTests();
