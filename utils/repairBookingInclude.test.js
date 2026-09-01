'use strict';

const assert = require('assert');

const { hydrateRepairItemsForBooking } = require('./repairBookingInclude');

function fakeModels(rows) {
    return {
        customerSelectedRepairItem: { findAll: async () => rows },
        customerSelectedRepairItemOption: {},
        customerSelectedRepairItemImage: {},
    };
}

async function runTests() {
    const garments = Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        bookingId: 1357,
        customerSelectedServiceId: null,
        serviceId: 2,
        garmentName: 'Shirt',
        quantity: 1,
    }));

    // Agent-itemised alteration invoice: the 12 declared garments belong to the
    // service, not to each priced line. Lines must keep their own quantity,
    // otherwise "16 lines × 1" is reported (and charged) as 16 × 12.
    const itemised = await hydrateRepairItemsForBooking(
        fakeModels(garments),
        1357,
        Array.from({ length: 16 }, (_, i) => ({
            id: 900 + i,
            serviceId: 2,
            items: 1,
            status: true,
        }))
    );
    assert.strictEqual(itemised.length, 16);
    for (const row of itemised) {
        assert.strictEqual(row.items, 1);
        assert.strictEqual(row.repairItems.length, 12);
        assert.strictEqual(row.repairItemsSharedAcrossLines, true);
    }

    // Un-itemised booking: the single line stands for the whole service, so it
    // still reports the declared garment count.
    const placeholder = await hydrateRepairItemsForBooking(
        fakeModels(garments),
        1357,
        [{ id: 900, serviceId: 2, items: 1, status: true }]
    );
    assert.strictEqual(placeholder[0].items, 12);
    assert.strictEqual(placeholder[0].repairItemsSharedAcrossLines, false);

    // Deactivated lines do not make a service look itemised.
    const withDeactivated = await hydrateRepairItemsForBooking(
        fakeModels(garments),
        1357,
        [
            { id: 900, serviceId: 2, items: 1, status: true },
            { id: 901, serviceId: 2, items: 1, status: false },
        ]
    );
    assert.strictEqual(withDeactivated[0].items, 12);

    // A single agent-priced line is not the service placeholder — the declared
    // garments belong to the deactivated snapshot row, not to this line.
    const singlePricedLine = await hydrateRepairItemsForBooking(
        fakeModels(garments),
        1357,
        [{ id: 950, serviceId: 2, subCategoryId: 77, items: 1, status: true }]
    );
    assert.strictEqual(singlePricedLine[0].items, 1);
    assert.strictEqual(singlePricedLine[0].repairItemsSharedAcrossLines, true);

    // Garments created against the line itself still set its quantity.
    const ownedByLine = await hydrateRepairItemsForBooking(
        fakeModels(
            garments.map((g) => ({ ...g, customerSelectedServiceId: 950 }))
        ),
        1357,
        [{ id: 950, serviceId: 2, subCategoryId: 77, items: 1, status: true }]
    );
    assert.strictEqual(ownedByLine[0].items, 12);
    assert.strictEqual(ownedByLine[0].repairItemsSharedAcrossLines, false);

    // Non-repair services are untouched.
    const wash = await hydrateRepairItemsForBooking(fakeModels(garments), 1357, [
        { id: 800, serviceId: 1, items: 2, status: true },
    ]);
    assert.strictEqual(wash[0].items, 2);
    assert.deepStrictEqual(wash[0].repairItems, []);

    console.log('repairBookingInclude.test.js: all assertions passed');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
