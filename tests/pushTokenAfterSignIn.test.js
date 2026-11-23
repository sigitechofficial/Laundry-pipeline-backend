'use strict';

/**
 * A push token missing at sign-in reaches the server later (POST /agent|customer/deviceToken)
 * and becomes this install's push address — through the real sign-in session, REST validator
 * and device-token controllers. Sessions are keyed by the install's deviceId
 * (utils/appSession.js); the push token is only a push address.
 *
 *  - sign in without a push token → session works, no push target yet;
 *  - the app reports the token later → stored against the install;
 *  - reported again (app start / resume) → idempotent, one row;
 *  - Firebase rotates it → the install's old token is replaced, the other install's kept;
 *  - logout of one install → only its session and tokens go.
 */

const assert = require('assert/strict');
const path = require('path');
const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');

process.env.JWT_ACCESS_SECRET = 'test-push-token-secret-not-for-prod';

const redis = new Map();
const fakeRedis = {
    async hSet(key, obj) { redis.set(key, { ...(redis.get(key) || {}), ...obj }); return 1; },
    async hGetAll(key) { return { ...(redis.get(key) || {}) }; },
    async hDel(key, field) { const h = redis.get(key) || {}; delete h[field]; return 1; },
    async del(key) { return redis.delete(key) ? 1 : 0; },
};

const rows = [];
let nextId = 1;
const matches = (row, where) =>
    Object.entries(where).every(([k, v]) => {
        if (Array.isArray(v)) return v.includes(row[k]);
        if (v && typeof v === 'object' && Op.ne in v) return row[k] !== v[Op.ne];
        return row[k] === v;
    });
const deviceToken = {
    async destroy({ where }) {
        let n = 0;
        for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) { rows.splice(i, 1); n += 1; }
        return n;
    },
    async create(values) { const r = { id: nextId++, deviceId: null, ...values }; rows.push(r); return r; },
    async findOne({ where }) {
        const r = rows.find((x) => matches(x, where));
        return r ? { ...r, update: async (v) => Object.assign(r, v) } : null;
    },
};
const users = { async findByPk(id) { return { id, status: true }; } };

function inject(relPath, exports) {
    const p = require.resolve(path.join(__dirname, '..', relPath));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
inject('models', { deviceToken, users });
inject('redis/redis', fakeRedis);
// The controllers' sign-in services are not under test here (sessions are opened below
// exactly as they open them, via openAppSession).
inject('services/Agent/authService', {});
inject('services/Customer/authService', {});
inject('services/Customer/guestAuthService', {});
inject('helper/otpMail', {});

const { resolveSessionIdentity, openAppSession, endAppSession } = require('../utils/appSession');
const validateAccessToken = require('../middlewares/accessToken');
const agentAuth = require('../controllers/Agent/authController');
const customerAuth = require('../controllers/Customer/customerAuth');

const IPAD = '0f8e2a4c-6b1d-4e3f-9a7c-5d2b8e1f4a6c';
const PHONE = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const FCM = (tag) => `${tag}:APA91b${'x'.repeat(120)}`;
const pushTargets = (userId) =>
    rows.filter((r) => r.userId === userId).map((r) => `${r.tokenId.split(':')[0]}@${r.deviceId}`).sort();

/** Authenticated request through the real REST validator, then the controller. */
function call(controller, accessToken, body = {}) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
            cookie() { return this; },
            clearCookie() { return this; },
        };
        const req = { url: '/deviceToken', cookies: {}, headers: { accesstoken: accessToken }, body, query: {} };
        validateAccessToken(req, res, () => Promise.resolve(controller(req, res)).catch(reject));
    });
}

const signIn = (userId, body) =>
    openAppSession({ userId, claims: { id: userId, email: `u${userId}@example.com` }, identity: resolveSessionIdentity(body) });

async function run() {
    for (const [label, updateDeviceToken, userId] of [
        ['agent', agentAuth.updateDeviceToken, 21],
        ['customer', customerAuth.updateDeviceToken, 31],
    ]) {
        // Sign in on the iPad without a push token (simulator / Firebase unavailable).
        const ipad = await signIn(userId, { deviceId: IPAD, dvToken: '' });
        assert.deepEqual(pushTargets(userId), [], `${label}: no push target yet`);

        // The token arrives later: the app reports it.
        let r = await call(updateDeviceToken, ipad, { dvToken: FCM('ipad1') });
        assert.equal(r.status, 200, `${label}: report accepted`);
        assert.deepEqual(pushTargets(userId), [`ipad1@${IPAD}`], `${label}: stored against the install`);

        // App start / resume report the same token again: idempotent.
        await call(updateDeviceToken, ipad, { dvToken: FCM('ipad1') });
        await call(updateDeviceToken, ipad, { dvToken: FCM('ipad1') });
        assert.deepEqual(pushTargets(userId), [`ipad1@${IPAD}`], `${label}: still one row`);

        // A placeholder is refused and changes nothing.
        r = await call(updateDeviceToken, ipad, { dvToken: 'no-fcm-token' });
        assert.equal(r.status, 400);
        assert.deepEqual(pushTargets(userId), [`ipad1@${IPAD}`]);

        // A phone signs in to the same account with a token. Sign-in makes the newest
        // device the account's push target (existing one-target-per-account policy), so
        // the iPad reports its token again on its next start/resume and both stay.
        const phone = await signIn(userId, { deviceId: PHONE, dvToken: FCM('phone') });
        await call(updateDeviceToken, ipad, { dvToken: FCM('ipad1') });
        assert.deepEqual(pushTargets(userId), [`ipad1@${IPAD}`, `phone@${PHONE}`].sort());

        // Firebase rotates the iPad's token: its old one is replaced, the phone's kept.
        await call(updateDeviceToken, ipad, { dvToken: FCM('ipad2') });
        assert.deepEqual(pushTargets(userId), [`ipad2@${IPAD}`, `phone@${PHONE}`].sort(), `${label}: rotation`);

        // Logout of the iPad: only its session and its tokens go.
        await endAppSession(jwt.decode(ipad));
        assert.deepEqual(pushTargets(userId), [`phone@${PHONE}`], `${label}: phone keeps pushes`);
        r = await call(updateDeviceToken, ipad, { dvToken: FCM('ipad3') });
        assert.equal(r.status, 403, `${label}: the signed-out install cannot report tokens`);
        r = await call(updateDeviceToken, phone, { dvToken: FCM('phone') });
        assert.equal(r.status, 200, `${label}: the phone is still signed in`);
    }

    console.log('pushTokenAfterSignIn.test.js: all assertions passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
