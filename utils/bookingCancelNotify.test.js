'use strict';

const assert = require('assert/strict');
const {
    CANCELLED_BY_CUSTOMER_EVENT,
    cancelNotifyShopAddressId,
    cancelNotifyRecipients,
    notifyShopOfCustomerCancellation,
} = require('./bookingCancelNotify');

function recorder({ owners = { 1: 2 }, failSocket = false, failPush = false } = {}) {
    const events = [];
    const pushes = [];
    return {
        events,
        pushes,
        deps: {
            findShopOwnerUserId: async (addressId) => owners[addressId] ?? null,
            sendEvent: async (userId, event) => {
                if (failSocket) throw new Error('socket down');
                events.push({ userId, event });
            },
            sendNotification: async (userId, title, body, data) => {
                if (failPush) throw new Error('fcm down');
                pushes.push({ userId, title, body, data });
            },
        },
    };
}

async function main() {
    // Real booking row loaded by cancelCustomerBooking for booking 185 (cash, accepted by
    // shop address 1 whose owner is user 2, kept with the owner as driver), captured
    // after a customer cancellation on the local stack.
    const booking185 = {
        id: 185,
        orderTrackId: '185-911203',
        laundryShopId: 1,
        adminAssignedShopId: null,
        driverId: 2,
    };

    // Owner who is also the driver is told once, over socket and push.
    {
        const r = recorder();
        assert.deepEqual(await notifyShopOfCustomerCancellation(booking185, r.deps), [2]);
        const body = 'Order #185-911203 was cancelled by the customer. Do not collect it.';
        assert.deepEqual(r.events, [
            { userId: 2, event: { type: CANCELLED_BY_CUSTOMER_EVENT, data: { bookingId: 185, message: body } } },
        ]);
        assert.deepEqual(r.pushes, [
            {
                userId: 2,
                title: 'Order cancelled',
                body,
                data: { bookingId: '185', orderTrackId: '185-911203', type: 'bookingCancelledByCustomer', message: body },
            },
        ]);
        // FCM data values must all be strings.
        for (const v of Object.values(r.pushes[0].data)) assert.equal(typeof v, 'string');
    }

    // A separate driver is told as well as the owner.
    {
        const r = recorder();
        const told = await notifyShopOfCustomerCancellation({ ...booking185, driverId: 9 }, r.deps);
        assert.deepEqual(told, [2, 9]);
        assert.equal(r.pushes.length, 2);
    }

    // Waiting for the admin-targeted shop to accept: that shop's owner is told.
    {
        const r = recorder({ owners: { 7: 70 } });
        const told = await notifyShopOfCustomerCancellation(
            { id: 186, orderTrackId: '186-1', laundryShopId: null, adminAssignedShopId: 7, driverId: null },
            r.deps
        );
        assert.deepEqual(told, [70]);
    }

    // Still an open offer (no shop, no driver): nobody to tell, nothing sent.
    {
        const r = recorder();
        const told = await notifyShopOfCustomerCancellation(
            { id: 182, orderTrackId: '182-895281', laundryShopId: null, adminAssignedShopId: null, driverId: null },
            r.deps
        );
        assert.deepEqual(told, []);
        assert.equal(r.events.length + r.pushes.length, 0);
    }

    // Socket or push failures never reach the cancel flow; the other channel still goes.
    {
        const r = recorder({ failSocket: true });
        assert.deepEqual(await notifyShopOfCustomerCancellation(booking185, r.deps), [2]);
        assert.equal(r.pushes.length, 1);
        const r2 = recorder({ failPush: true });
        assert.deepEqual(await notifyShopOfCustomerCancellation(booking185, r2.deps), [2]);
        assert.equal(r2.events.length, 1);
        const broken = { ...recorder().deps, findShopOwnerUserId: async () => { throw new Error('db'); } };
        assert.deepEqual(await notifyShopOfCustomerCancellation(booking185, broken), []);
    }

    assert.equal(cancelNotifyShopAddressId({ laundryShopId: 3, adminAssignedShopId: 4 }), 3);
    assert.deepEqual(cancelNotifyRecipients({ shopOwnerUserId: '2', driverId: 0 }), [2]);

    console.log('bookingCancelNotify.test.js: all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
