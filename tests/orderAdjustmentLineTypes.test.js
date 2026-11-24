'use strict';

/**
 * Every lineType the promotion engine writes to order_adjustments must be storable:
 * a promotion landing on a line priced for a whole service (no subCategoryId) produced
 * lineType 'service', which the column's ENUM did not allow — the INSERT failed and every
 * invoice open of that order answered 500 while promotions checkout was on.
 */
const assert = require('assert');
const { Sequelize, DataTypes } = require('sequelize');
const { createPricingState, toAdjustments } = require('../services/promotions/benefitHandlers');
const defineOrderAdjustment = require('../models/orderAdjustment');
const migration = require('../migrations/20261125120000-order-adjustments-line-type-service');

// ── The engine's line kinds ──────────────────────────────────────────────────
const state = createPricingState({
    basket: {
        lineItems: [
            { subCategoryId: 11, serviceId: 1, price: 10, qty: 1 }, // item
            { addonId: 7, serviceId: 1, price: 2, qty: 1 }, // add-on
            { serviceId: 9, price: 12, qty: 1 }, // whole service, no item (alteration)
        ],
        deliveryFee: 3,
    },
});
const rows = toAdjustments(state, {
    lineMinor: [100, 20, 120],
    deliveryMinor: 300,
    cashbackMinor: 50,
    label: 'Offer',
    description: null,
});
const produced = [...new Set(rows.map((r) => r.lineType))].sort();
assert.deepStrictEqual(produced, ['addon', 'basket', 'delivery', 'service', 'subCategory']);
const serviceRow = rows.find((r) => r.lineType === 'service');
assert.strictEqual(serviceRow.lineItemId, 9, "a 'service' line carries the service id");

// ── …all storable by the model ───────────────────────────────────────────────
const sequelize = new Sequelize('mysql://user:pass@127.0.0.1:1/none', { logging: false });
const OrderAdjustment = defineOrderAdjustment(sequelize, DataTypes);
const allowed = OrderAdjustment.rawAttributes.lineType.values;
for (const type of produced) assert.ok(allowed.includes(type), `model ENUM allows '${type}'`);

// ── …and by the database once the migration ran ─────────────────────────────
function fakeQueryInterface(columnType, serviceRows = 0) {
    const statements = [];
    return {
        statements,
        sequelize: {
            QueryTypes: { SELECT: 'SELECT' },
            escape: (v) => `'${String(v).replace(/'/g, "''")}'`,
            query: async (sql) => {
                if (/information_schema\.COLUMNS/.test(sql)) return [{ type: columnType, nullable: 'NO', def: 'basket' }];
                if (/SELECT COUNT\(\*\)/.test(sql)) return [{ n: serviceRows }];
                statements.push(sql.replace(/\s+/g, ' ').trim());
                return [];
            },
        },
    };
}

(async () => {
    const before = "enum('subCategory','addon','delivery','basket')";
    let qi = fakeQueryInterface(before);
    await migration.up(qi);
    assert.deepStrictEqual(qi.statements, [
        "ALTER TABLE `order_adjustments` MODIFY COLUMN `lineType` ENUM('subCategory', 'addon', 'delivery', 'basket', 'service') NOT NULL DEFAULT 'basket'",
    ], 'appends the member, keeps order, NOT NULL and default');
    for (const type of produced) assert.ok(qi.statements[0].includes(`'${type}'`), `column allows '${type}'`);

    // Idempotent: already there → nothing.
    qi = fakeQueryInterface("enum('subCategory','addon','delivery','basket','service')");
    await migration.up(qi);
    assert.deepStrictEqual(qi.statements, []);

    // Members added elsewhere are kept.
    qi = fakeQueryInterface("enum('subCategory','addon','delivery','basket','extra')");
    await migration.up(qi);
    assert.match(qi.statements[0], /ENUM\('subCategory', 'addon', 'delivery', 'basket', 'extra', 'service'\)/);

    // Down: refused while rows use it; otherwise removes only that member.
    await assert.rejects(
        () => migration.down(fakeQueryInterface("enum('subCategory','addon','delivery','basket','service')", 2)),
        /would be lost/
    );
    qi = fakeQueryInterface("enum('subCategory','addon','delivery','basket','service')", 0);
    await migration.down(qi);
    assert.match(qi.statements[0], /ENUM\('subCategory', 'addon', 'delivery', 'basket'\) NOT NULL DEFAULT 'basket'$/);

    console.log('orderAdjustmentLineTypes tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
