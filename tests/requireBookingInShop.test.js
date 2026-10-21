'use strict';

require('./stubSequelizeModels').install();

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const requireBookingInShop = require('../middlewares/requireBookingInShop');
const { attachShopAgentContext } = require('../utils/shopAgentContext');

// bookingId → laundryShopId, laundryShopId (addressDb.id) → addressDb.userId (shop owner)
const bookings = { 100: 55, 101: 66, 102: null };
const shopOwners = { 55: 10, 66: 11 };

const gate = requireBookingInShop.create({
    async loadBooking(bookingId) {
        const id = Number(bookingId);
        return Object.prototype.hasOwnProperty.call(bookings, id)
            ? { id, laundryShopId: bookings[id] }
            : null;
    },
    async resolveShopOwnerUserId(laundryShopId) {
        return shopOwners[laundryShopId] ?? null;
    },
});

async function invoke(mw, req) {
    let nextArg = 'not-called';
    await mw(req, {}, (err) => {
        nextArg = err;
    });
    return nextArg;
}

/** Request as it looks after validateAccessToken (req.user + shop context). */
function agentReq(user, bookingId) {
    const req = { user, params: { bookingId: String(bookingId) } };
    attachShopAgentContext(req);
    return req;
}

function assertAllowed(nextArg, label) {
    assert.equal(nextArg, undefined, `${label}: expected next() with no error`);
}

function assertNotFound(nextArg, label) {
    assert.ok(nextArg instanceof Error, `${label}: expected an error`);
    assert.equal(nextArg.statusCode, 404, `${label}: expected 404`);
    assert.equal(nextArg.message, 'Booking not found');
}

const owner10 = { id: 10 };
const manager10 = { id: 20, classifiedAsId: 1, employeeOff: 10, roleId: 8 };
const driver10 = { id: 21, classifiedAsId: 1, employeeOff: 10, roleId: 6 };
const owner11 = { id: 11 };
const manager11 = { id: 30, classifiedAsId: 1, employeeOff: 11, roleId: 8 };

async function run() {
    assertAllowed(await invoke(gate, agentReq(owner10, 100)), 'owner, own booking');
    assertAllowed(await invoke(gate, agentReq(manager10, 100)), 'manager, own shop booking');
    assertAllowed(await invoke(gate, agentReq(driver10, 100)), 'driver, own shop booking');
    assertAllowed(await invoke(gate, agentReq(owner11, 101)), 'other owner, their own booking');

    assertNotFound(await invoke(gate, agentReq(owner10, 101)), 'owner, other shop booking');
    assertNotFound(await invoke(gate, agentReq(manager11, 100)), 'staff, other shop booking');
    assertNotFound(await invoke(gate, agentReq(owner10, 999)), 'missing booking');
    assertNotFound(await invoke(gate, agentReq(owner10, 102)), 'booking with no shop yet');
    // A shop employee's own id must not unlock bookings owned by that id.
    assertNotFound(
        await invoke(gate, agentReq({ id: 10, classifiedAsId: 1, employeeOff: 11 }, 100)),
        'employee resolves to employeeOff, not own id'
    );

    // req.shopAgentId missing (route mounted without attachShopAgentContext) → resolve from req.user.
    assertAllowed(await invoke(gate, { user: manager10, params: { bookingId: '100' } }), 'fallback resolve');
    assertNotFound(await invoke(gate, { params: { bookingId: '100' } }), 'no user');
    assertNotFound(await invoke(gate, agentReq(owner10, '')), 'no bookingId');

    const boom = new Error('db down');
    const failing = requireBookingInShop.create({
        async loadBooking() {
            throw boom;
        },
    });
    assert.equal(await invoke(failing, agentReq(owner10, 100)), boom, 'loader errors reach the error handler');

    assert.equal(requireBookingInShop.isSameShopOwner(10, '10'), true);
    assert.equal(requireBookingInShop.isSameShopOwner(null, 10), false);
    assert.equal(requireBookingInShop.isSameShopOwner(0, 0), false);
    assert.equal(requireBookingInShop.isSameShopOwner('abc', NaN), false);

    // Route wiring: agent route is shop-gated, admin route (same controller) is not.
    const routeBlock = (file, routePath) => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
        const start = src.indexOf(`"${routePath}"`);
        assert.ok(start >= 0, `${file} must define ${routePath}`);
        return src.slice(start, src.indexOf(')', src.indexOf('agentController.printLabelData', start)));
    };
    const agentRoute = routeBlock('agent.js', '/printLabelData/:bookingId');
    assert.match(
        agentRoute,
        /validateAccessToken,[\s\S]*requireBookingInShop,[\s\S]*agentController\.printLabelData/,
        'agent printLabelData must run requireBookingInShop after validateAccessToken'
    );
    assert.doesNotMatch(
        routeBlock('admin.js', '/printLabelData/:bookingId'),
        /requireBookingInShop/,
        'admin printLabelData must stay un-gated by shop'
    );

    console.log('requireBookingInShop.test.js: ok');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
