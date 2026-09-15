'use strict';

const assert = require('assert');
const { buildAddOnsForTag, formatAddOnTagPart } = require('./printLabelAddOns');

assert.strictEqual(
    formatAddOnTagPart({ name: 'Trouser New Zip', items: 1, instructions: 'new zip' }),
    'Trouser New Zip x1: new zip'
);
assert.strictEqual(
    formatAddOnTagPart({ name: 'Trouser Taper', qty: 1 }),
    'Trouser Taper x1'
);

const empty = buildAddOnsForTag([]);
assert.strictEqual(empty.display, 'No add-ons');
assert.deepStrictEqual(empty.list, []);

const built = buildAddOnsForTag([
    {
        addOnServiceId: 4,
        items: 1,
        instructions: 'waist in 1 inch',
        addOnService: { id: 4, name: 'Trouser Waist In' },
    },
    {
        addOnServiceId: 5,
        items: 2,
        instructions: '  ',
        addOnService: { name: 'Trouser Taper' },
    },
]);

assert.strictEqual(
    built.display,
    'Trouser Waist In x1: waist in 1 inch, Trouser Taper x2'
);
assert.strictEqual(built.list[0].items, 1);
assert.strictEqual(built.list[0].qty, 1);
assert.strictEqual(built.list[0].instructions, 'waist in 1 inch');
assert.strictEqual(built.list[1].instructions, null);

console.log('printLabelAddOns tests passed');
