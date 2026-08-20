'use strict';

const assert = require('assert');
const {
    ORDER_LIST_SORT_FIELDS,
    PAYMENT_FAILURE_SORT_FIELDS,
    resolveOrderListSort,
    buildOrderListSequelizeOrder,
} = require('./orderListSort');

function runTests() {
    assert.deepStrictEqual(
        Object.keys(ORDER_LIST_SORT_FIELDS).sort(),
        [
            'bookingStatusId',
            'collectionDate',
            'createdAt',
            'deliveryDate',
            'id',
            'orderAmount',
            'totalItems',
            'updatedAt',
        ]
    );
    assert.strictEqual(PAYMENT_FAILURE_SORT_FIELDS.lastPaymentFailureAt, 'lastPaymentFailureAt');
    assert.strictEqual(PAYMENT_FAILURE_SORT_FIELDS.deliveryDate, 'deliveryDate');
    assert.strictEqual(PAYMENT_FAILURE_SORT_FIELDS.orderAmount, 'orderAmount');
    assert.strictEqual(PAYMENT_FAILURE_SORT_FIELDS.id, 'id');

    assert.deepStrictEqual(buildOrderListSequelizeOrder(), [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder(undefined, undefined), [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
    ]);

    assert.deepStrictEqual(buildOrderListSequelizeOrder('createdAt', 'asc'), [
        ['createdAt', 'ASC'],
        ['id', 'DESC'],
    ]);
    assert.notDeepStrictEqual(
        buildOrderListSequelizeOrder('createdAt', 'asc'),
        buildOrderListSequelizeOrder()
    );

    assert.deepStrictEqual(buildOrderListSequelizeOrder('collectionDate', 'DESC'), [
        ['collectionDate', 'DESC'],
        ['id', 'DESC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder('bookingStatusId', 'asc'), [
        ['bookingStatusId', 'ASC'],
        ['id', 'DESC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder('updatedAt', 'desc'), [
        ['updatedAt', 'DESC'],
        ['id', 'DESC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder('id', 'asc'), [
        ['id', 'ASC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder('deliveryDate', 'asc'), [
        ['deliveryDate', 'ASC'],
        ['id', 'DESC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder('orderAmount', 'DESC'), [
        ['orderAmount', 'DESC'],
        ['id', 'DESC'],
    ]);
    assert.deepStrictEqual(buildOrderListSequelizeOrder('totalItems', 'asc'), [
        ['totalItems', 'ASC'],
        ['id', 'DESC'],
    ]);

    const unknownColumn = buildOrderListSequelizeOrder('orderTrackId; DROP TABLE bookings', 'asc');
    assert.deepStrictEqual(unknownColumn, [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
    ]);
    assert.ok(!JSON.stringify(unknownColumn).includes('orderTrackId'));
    assert.ok(!JSON.stringify(unknownColumn).includes('DROP'));

    for (const rejected of [
        'orderTrackId',
        'customer',
        'phoneNum',
        'email',
        'laundryShopId',
        'shopName',
    ]) {
        const resolved = resolveOrderListSort(rejected, 'asc');
        assert.strictEqual(resolved.known, false);
        assert.strictEqual(resolved.sortBy, 'createdAt');
        assert.strictEqual(resolved.sortDir, 'DESC');
    }

    assert.deepStrictEqual(
        buildOrderListSequelizeOrder('hackedColumn', 'asc', {
            allowlist: PAYMENT_FAILURE_SORT_FIELDS,
            defaultSortBy: 'lastPaymentFailureAt',
            defaultSortDir: 'DESC',
        }),
        [
            ['lastPaymentFailureAt', 'DESC'],
            ['id', 'DESC'],
        ]
    );
    assert.deepStrictEqual(
        buildOrderListSequelizeOrder('lastPaymentFailureAt', 'asc', {
            allowlist: PAYMENT_FAILURE_SORT_FIELDS,
            defaultSortBy: 'lastPaymentFailureAt',
            defaultSortDir: 'DESC',
        }),
        [
            ['lastPaymentFailureAt', 'ASC'],
            ['id', 'DESC'],
        ]
    );
    assert.deepStrictEqual(
        buildOrderListSequelizeOrder('createdAt', 'asc', {
            allowlist: PAYMENT_FAILURE_SORT_FIELDS,
            defaultSortBy: 'lastPaymentFailureAt',
            defaultSortDir: 'DESC',
        }),
        [
            ['createdAt', 'ASC'],
            ['id', 'DESC'],
        ]
    );

    assert.strictEqual(resolveOrderListSort('createdAt', 'up').sortDir, 'DESC');
    assert.strictEqual(resolveOrderListSort('createdAt', 'ASC').sortDir, 'ASC');

    console.log('orderListSort.test.js: all assertions passed');
}

runTests();
