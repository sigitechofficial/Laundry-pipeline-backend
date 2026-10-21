'use strict';

/**
 * Drives the real socket_io.js joinRoom / re-connect / agentAcceptOrder handlers
 * with a fake socket.io Server, stubbed models, and an in-memory Redis.
 */

const assert = require('assert/strict');
const Module = require('module');
const jwt = require('jsonwebtoken');

const SECRET = 'test-socket-room-secret-not-for-prod';
const prevSecret = process.env.JWT_ACCESS_SECRET;
const prevMode = process.env.SOCKET_AUTH_MODE;
process.env.JWT_ACCESS_SECRET = SECRET;
delete process.env.SOCKET_AUTH_MODE;

const redisSessions = {};
const heldReleaseCalls = [];
const acceptCalls = [];
const blockedUserIds = new Set();

class FakeServer {
    constructor() {
        this.handlers = {};
    }
    on(event, handler) {
        this.handlers[event] = handler;
    }
}

const stubs = {
    'socket.io': { Server: FakeServer },
    './services/Agent/agentBookingDeclineService': {},
    './utils/bookingTakenNotify': { notifyBookingTakenByAgent() {} },
    './utils/triggerHeldReleaseForAgent': {
        async triggerHeldReleaseForAgent(userId) {
            heldReleaseCalls.push(String(userId));
            return { released: 0 };
        },
    },
    './services/Agent/agentAcceptOrderService': {
        async acceptOrderForAgent(agentId, bookingId) {
            acceptCalls.push({ agentId: String(agentId), bookingId: String(bookingId) });
        },
    },
    '../redis/redis': {
        async hGetAll(key) {
            return redisSessions[key] || {};
        },
    },
};

const fakeModels = {
    users: {
        async findByPk(id) {
            return { id, status: blockedUserIds.has(Number(id)) ? false : true };
        },
    },
    unAcknowledgedEvents: {
        async findAll() {
            return [];
        },
        async create() {},
        async destroy() {},
    },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (request === './models' || request === '../models' || request.endsWith('/models')) {
        return fakeModels;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { intilizeSocketFunc } = require('../socket_io');
const io = intilizeSocketFunc({});

function login(id, dvToken = 'device-1', extra = {}) {
    const token = jwt.sign({ id, email: `u${id}@example.com`, dvToken, ...extra }, SECRET);
    redisSessions[`id-${id}`] = { ...(redisSessions[`id-${id}`] || {}), [dvToken]: token };
    return token;
}

function connect(handshake = {}) {
    const handlers = {};
    const socket = {
        id: `sock-${Math.random().toString(36).slice(2, 8)}`,
        handshake,
        data: {},
        rooms: new Set(),
        emitted: [],
        on(event, handler) {
            handlers[event] = handler;
        },
        join(room) {
            this.rooms.add(room);
        },
        leave(room) {
            this.rooms.delete(room);
        },
        emit(event, payload) {
            this.emitted.push({ event, payload });
        },
    };
    io.handlers.connection(socket);
    socket.fire = (event, payload) =>
        handlers[event](typeof payload === 'string' ? payload : JSON.stringify(payload));
    socket.last = (event) => [...socket.emitted].reverse().find((e) => e.event === event);
    return socket;
}

async function run() {
    const ownerToken = login(7);
    const staffToken = login(21, 'device-9', { employeeOff: 7, roleId: 8, classifiedAsId: 1 });

    // Owner with token joins own room.
    let s = connect();
    await s.fire('joinRoom', { userId: '7', userTypeId: 4, type: 'connected', accessToken: ownerToken });
    assert.deepEqual([...s.rooms], ['7']);
    assert.equal(s.last('roomJoined').payload.userId, '7');
    assert.equal(s.data.authenticated, true);
    assert.deepEqual(heldReleaseCalls, ['7']);

    // Staff token joins the staff member's own room (staffJobAssigned etc.).
    s = connect();
    await s.fire('joinRoom', { userId: '21', accessToken: staffToken });
    assert.deepEqual([...s.rooms], ['21']);

    // Valid token, someone else's room → refused, joins nothing.
    s = connect();
    await s.fire('joinRoom', { userId: '21', accessToken: ownerToken });
    assert.equal(s.rooms.size, 0);
    assert.equal(s.last('error').payload.code, 'ROOM_FORBIDDEN');
    assert.equal(s.last('roomJoined'), undefined);

    // Forged / logged-out token → refused even in optional mode.
    s = connect();
    await s.fire('joinRoom', { userId: '7', accessToken: jwt.sign({ id: 7, dvToken: 'device-1' }, 'attacker') });
    assert.equal(s.rooms.size, 0);
    assert.equal(s.last('error').payload.code, 'INVALID_TOKEN');

    const loggedOut = login(30);
    delete redisSessions['id-30'];
    s = connect();
    await s.fire('joinRoom', { userId: '30', accessToken: loggedOut });
    assert.equal(s.rooms.size, 0);
    assert.equal(s.last('error').payload.code, 'INVALID_TOKEN');

    // Blocked account → refused.
    const blockedToken = login(31);
    blockedUserIds.add(31);
    s = connect();
    await s.fire('joinRoom', { userId: '31', accessToken: blockedToken });
    assert.equal(s.rooms.size, 0);
    assert.equal(s.last('error').payload.code, 'ACCOUNT_BLOCKED');

    // Token via handshake auth (io(url, { auth: { token } })).
    s = connect({ auth: { token: ownerToken } });
    await s.fire('joinRoom', { userId: '7' });
    assert.deepEqual([...s.rooms], ['7']);

    // re-connect is gated the same way and still replays pending events.
    s = connect();
    await s.fire('re-connect', { userId: '7', accessToken: ownerToken });
    assert.deepEqual([...s.rooms], ['7']);
    assert.equal(s.last('reconnected').payload.pendingEvents, 0);
    s = connect();
    await s.fire('re-connect', { userId: '21', accessToken: ownerToken });
    assert.equal(s.rooms.size, 0);
    assert.equal(s.last('reconnected'), undefined);

    // Account switch on the same socket leaves the previous room.
    s = connect();
    await s.fire('joinRoom', { userId: '7', accessToken: ownerToken });
    await s.fire('joinRoom', { userId: '21', accessToken: staffToken });
    assert.deepEqual([...s.rooms], ['21']);

    // agentAcceptOrder on an authenticated socket ignores a forged agentId.
    s = connect();
    await s.fire('joinRoom', { userId: '7', accessToken: ownerToken });
    await s.fire('agentAcceptOrder', { id: '500', agentId: '7', laundryShopId: '3' });
    assert.deepEqual(acceptCalls.pop(), { agentId: '7', bookingId: '500' });
    await s.fire('agentAcceptOrder', { id: '501', agentId: '99', laundryShopId: '3' });
    assert.equal(acceptCalls.length, 0);
    assert.equal(s.last('error').payload.code, 'ROOM_FORBIDDEN');

    // Transition (SOCKET_AUTH_MODE unset = optional): legacy app builds still work.
    s = connect();
    await s.fire('joinRoom', { userId: '8', userTypeId: 4, type: 'connected' });
    assert.deepEqual([...s.rooms], ['8']);
    assert.equal(s.data.authenticated, false);
    await s.fire('agentAcceptOrder', { id: '502', agentId: '8' });
    assert.deepEqual(acceptCalls.pop(), { agentId: '8', bookingId: '502' });
    s = connect();
    await s.fire('joinRoom', { userId: 'null' });
    assert.equal(s.last('error').payload.code, 'INVALID_USER_ID');

    // Enforced: token-less joins and actions are refused.
    process.env.SOCKET_AUTH_MODE = 'required';
    s = connect();
    await s.fire('joinRoom', { userId: '8', userTypeId: 4 });
    assert.equal(s.rooms.size, 0);
    assert.equal(s.last('error').payload.code, 'AUTH_REQUIRED');
    await s.fire('re-connect', { userId: '8' });
    assert.equal(s.rooms.size, 0);
    await s.fire('agentAcceptOrder', { id: '503', agentId: '8' });
    assert.equal(acceptCalls.length, 0);
    s = connect();
    await s.fire('joinRoom', { userId: '7', accessToken: ownerToken });
    assert.deepEqual([...s.rooms], ['7'], 'token clients keep working when enforced');
}

const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
console.warn = () => {};
console.error = () => {};

run()
    .then(() => {
        Object.assign(console, quiet);
        console.log('socketRoomAuth.test.js: ok');
    })
    .catch((err) => {
        Object.assign(console, quiet);
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        Module._load = originalLoad;
        if (prevSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
        else process.env.JWT_ACCESS_SECRET = prevSecret;
        if (prevMode === undefined) delete process.env.SOCKET_AUTH_MODE;
        else process.env.SOCKET_AUTH_MODE = prevMode;
    });
