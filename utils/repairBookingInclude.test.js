'use strict';

const assert = require('assert');

const {
    hydrateRepairItemsForBooking,
    hydrateRepairItemsForBookings,
    normalizeRepairItem,
    repairItemsOrder,
} = require('./repairBookingInclude');

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

    // Board of several bookings: ONE repair-items query (bookingId IN …), and each booking
    // gets exactly what the single-booking hydrate gives it.
    const boardRows = [
        ...garments,
        { id: 90, bookingId: 2468, customerSelectedServiceId: 700, serviceId: 2, garmentName: 'Dress', quantity: 2 },
    ];
    const queries = [];
    const batchModels = {
        customerSelectedRepairItem: {
            findAll: async (opts) => {
                queries.push(opts.where.bookingId);
                const ids = [].concat(opts.where.bookingId).map(Number);
                return boardRows.filter((r) => ids.includes(Number(r.bookingId)));
            },
        },
        customerSelectedRepairItemOption: {},
        customerSelectedRepairItemImage: {},
    };
    const entries = [
        { bookingId: 1357, selectedServices: [{ id: 950, serviceId: 2, items: 1, status: true }] },
        { bookingId: 2468, selectedServices: [{ id: 700, serviceId: 2, items: 1, status: true }] },
        { bookingId: 9999, selectedServices: [{ id: 1, serviceId: 1, items: 3, status: true }] },
        { bookingId: 1111, selectedServices: [] },
    ];
    const board = await hydrateRepairItemsForBookings(batchModels, entries);
    assert.deepStrictEqual(queries, [[1357, 2468, 9999]], 'one query for the board');
    for (let i = 0; i < entries.length; i += 1) {
        const single = await hydrateRepairItemsForBooking(
            fakeModels(boardRows.filter((r) => Number(r.bookingId) === Number(entries[i].bookingId))),
            entries[i].bookingId,
            entries[i].selectedServices
        );
        assert.deepStrictEqual(board[i], single, `booking ${entries[i].bookingId} same as single hydrate`);
    }
    assert.strictEqual(board[1][0].items, 2);
    assert.deepStrictEqual(board[3], []);

    // A failed query degrades every booking the same way the single hydrate does.
    const failing = {
        ...batchModels,
        customerSelectedRepairItem: { findAll: async () => { throw new Error('table missing'); } },
    };
    const degraded = await hydrateRepairItemsForBookings(failing, entries.slice(0, 2));
    assert.deepStrictEqual(degraded[0][0].repairItems, []);
    assert.strictEqual(degraded[0][0].items, 1);

    // Options and images come out in a fixed order whatever order the join returned.
    const shuffled = normalizeRepairItem({
        id: 1,
        serviceId: 9,
        options: [{ id: 12, optionName: 'Taper' }, { id: 3, optionName: 'Shorten' }, { id: 7, optionName: 'Hem' }],
        images: [
            { id: 9, imageUrl: 'b.jpg', sortOrder: 1 },
            { id: 4, imageUrl: 'c.jpg', sortOrder: 1 },
            { id: 8, imageUrl: 'a.jpg', sortOrder: 0 },
        ],
    });
    assert.deepStrictEqual(shuffled.options.map((o) => o.id), [3, 7, 12]);
    assert.deepStrictEqual(shuffled.images.map((i) => i.id), [8, 4, 9]);
    const Option = { name: 'option' };
    const Image = { name: 'image' };
    assert.deepStrictEqual(
        repairItemsOrder({ customerSelectedRepairItemOption: Option, customerSelectedRepairItemImage: Image }),
        [
            ['id', 'ASC'],
            [{ model: Option, as: 'options' }, 'id', 'ASC'],
            [{ model: Image, as: 'images' }, 'sortOrder', 'ASC'],
            [{ model: Image, as: 'images' }, 'id', 'ASC'],
        ]
    );

    console.log('repairBookingInclude.test.js: all assertions passed');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
