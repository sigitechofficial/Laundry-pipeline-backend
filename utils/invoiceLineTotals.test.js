'use strict';

const assert = require('assert');
const {
    getLineQuantity,
    getLineSubtotal,
    getSelectedServiceRowSubtotal,
} = require('./invoiceLineTotals');

function runTests() {
    assert.strictEqual(getLineQuantity(2), 2);
    assert.strictEqual(getLineQuantity('2'), 2);
    assert.strictEqual(getLineQuantity(0), 1);
    assert.strictEqual(getLineQuantity(null), 1);
    assert.strictEqual(getLineQuantity(undefined), 1);

    assert.strictEqual(getLineSubtotal(2.95, 2), 5.9);
    assert.strictEqual(getLineSubtotal(7.95, 2), 15.9);
    assert.strictEqual(getLineSubtotal(15, 1), 15);

    assert.strictEqual(
        getSelectedServiceRowSubtotal({ categoryPrice: 2.95, items: 2 }),
        5.9
    );
    assert.strictEqual(
        getSelectedServiceRowSubtotal({ categoryPrice: '7.95', items: '2' }),
        15.9
    );

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

    console.log('invoiceLineTotals.test.js: all assertions passed');
}

runTests();
