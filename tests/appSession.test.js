'use strict';

/**
 * App sessions are keyed by the install's deviceId, not by the push token
 * (utils/sessionIdentity.js, utils/appSession.js), end to end through the REST validators:
 * sign in without a push token, several installs per account, logout revokes one install,
 * push tokens follow the install, and LEGACY dvToken-only builds keep working.
 */

const assert = require('assert/strict');
const path = require('path');
const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');

process.env.JWT_ACCESS_SECRET = 'test-app-session-secret-not-for-prod';

// ── In-memory Redis and models, injected before the modules under test load ──────────
const redis = new Map(); // key -> { field: value }
const fakeRedis = {
    async hSet(key, obj) { redis.set(key, { ...(redis.get(key) || {}), ...obj }); return 1; },
    async hGetAll(key) { return { ...(redis.get(key) || {}) }; },
    async hDel(key, field) { const h = redis.get(key) || {}; const had = field in h; delete h[field]; return had ? 1 : 0; },
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
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (matches(rows[i], where)) { rows.splice(i, 1); n += 1; }
        }
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

const {
    DEVICE_ID_ERROR,
    resolveSessionIdentity,
    identityOfSession,
    sessionFieldOf,
    openAppSession,
    endAppSession,
} = require('../utils/appSession');
const { saveCurrentToken } = require('../utils/deviceTokenStore');
const validateAccessToken = require('../middlewares/accessToken');
const validateAccessTokenOrGuest = require('../middlewares/accessTokenOrGuest');

const IPAD = '0f8e2a4c-6b1d-4e3f-9a7c-5d2b8e1f4a6c';
const PHONE = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678'; // upper case on the wire
const PHONE_ID = PHONE.toLowerCase();
const FCM = (tag) => `${tag}:APA91b${'x'.repeat(120)}`; // shaped like a real FCM token
const tokensOf = (userId) => rows.filter((r) => r.userId === userId).map((r) => `${r.tokenId.split(':')[0]}@${r.deviceId}`).sort();

/** Runs a REST validator; resolves { status, user } (status 200 = next() was called). */
function callValidator(validator, accessToken) {
    return new Promise((resolve) => {
        const req = { url: '/test', cookies: {}, headers: { accesstoken: accessToken } };
        const res = {
            status(code) { this.code = code; return this; },
            json() { resolve({ status: this.code }); return this; },
        };
        Promise.resolve(validator(req, res, () => resolve({ status: 200, user: req.user }))).catch((e) => resolve({ status: 500, error: e }));
    });
}

const rejectsCode = (fn, code) => assert.throws(fn, (e) => e.name === 'ValidationError' && e.details?.code === code);

async function run() {
    // ── Identity from a sign-in body ──────────────────────────────────────────────────
    const idNoPush = resolveSessionIdentity({ deviceId: IPAD });
    assert.deepEqual(idNoPush, { field: IPAD, claims: { deviceId: IPAD }, deviceId: IPAD, pushToken: null, legacy: false });

    const idPhone = resolveSessionIdentity({ deviceId: ` ${PHONE} `, dvToken: FCM('phone') });
    assert.equal(idPhone.field, PHONE_ID, 'deviceId is canonical lower case');
    assert.equal(idPhone.pushToken, FCM('phone'));

    // A placeholder push token is not a push address (and never the session id when a deviceId is sent).
    assert.equal(resolveSessionIdentity({ deviceId: IPAD, dvToken: 'no-fcm-token' }).pushToken, null);

    rejectsCode(() => resolveSessionIdentity({ deviceId: 'not-a-uuid', dvToken: FCM('x') }), DEVICE_ID_ERROR.INVALID);
    rejectsCode(() => resolveSessionIdentity({}), DEVICE_ID_ERROR.REQUIRED);
    rejectsCode(() => resolveSessionIdentity({ dvToken: '   ' }), DEVICE_ID_ERROR.REQUIRED);
    assert.equal(resolveSessionIdentity({}, { required: false }), null, 'never invents an id');

    // LEGACY: dvToken-only builds — the session is named by that token, exactly as before.
    const idLegacy = resolveSessionIdentity({ dvToken: FCM('old') });
    assert.deepEqual(idLegacy, { field: FCM('old'), claims: { dvToken: FCM('old') }, deviceId: null, pushToken: FCM('old'), legacy: true });
    assert.equal(resolveSessionIdentity({ dvToken: 'device-1' }).pushToken, null, 'legacy placeholder: session yes, push no');

    // ── Session field from token claims ───────────────────────────────────────────────
    assert.equal(sessionFieldOf({ deviceId: IPAD, dvToken: 'ignored' }), IPAD);
    assert.equal(sessionFieldOf({ dvToken: FCM('old') }), FCM('old'));
    assert.equal(sessionFieldOf({ id: 1 }), null);
    assert.equal(sessionFieldOf(null), null);

    // ── Re-issuing a signed-in session (agent /session) ──────────────────────────────
    const refreshed = identityOfSession({ id: 7, deviceId: IPAD }, { deviceId: PHONE, dvToken: FCM('ipad') });
    assert.equal(refreshed.field, IPAD, 'the body cannot move the session to another install');
    assert.equal(refreshed.pushToken, FCM('ipad'));
    assert.equal(identityOfSession({ id: 7, dvToken: FCM('old') }, {}).field, FCM('old'));
    assert.equal(identityOfSession({ id: 7, dvToken: FCM('old') }, { dvToken: FCM('new') }).field, FCM('new'), 'legacy behaviour kept');

    // ── Sign in: iPad (no push token — simulator) and phone (push token), same account ─
    const ipadToken = await openAppSession({ userId: 7, claims: { id: 7, email: 'm@example.com', roleId: 8 }, identity: idNoPush });
    const phoneToken = await openAppSession({ userId: 7, claims: { id: 7, email: 'm@example.com', roleId: 8 }, identity: idPhone });
    assert.deepEqual(Object.keys(redis.get('id-7')).sort(), [IPAD, PHONE_ID].sort(), 'one session per install');
    const ipadClaims = jwt.decode(ipadToken);
    assert.equal(ipadClaims.deviceId, IPAD);
    assert.equal('dvToken' in ipadClaims, false, 'the push token is not part of the session');
    assert.equal(ipadClaims.roleId, 8);
    assert.deepEqual(tokensOf(7), [`phone@${PHONE_ID}`], 'only the install with a push token is a push target');

    // Both installs pass the REST validators.
    for (const validator of [validateAccessToken, validateAccessTokenOrGuest]) {
        const ipad = await callValidator(validator, ipadToken);
        assert.equal(ipad.status, 200);
        assert.equal(ipad.user.deviceId, IPAD);
        assert.equal((await callValidator(validator, phoneToken)).status, 200);
    }

    // The iPad gets a push token later (POST /agent/deviceToken): stored against the install;
    // a rotation replaces that install's old token only.
    await saveCurrentToken(7, FCM('ipad1'), IPAD);
    await saveCurrentToken(7, FCM('ipad2'), IPAD);
    assert.deepEqual(tokensOf(7), [`ipad2@${IPAD}`, `phone@${PHONE_ID}`]);

    // ── Logout of the iPad: only its session and its pushes go ───────────────────────
    await endAppSession(jwt.decode(ipadToken));
    assert.equal((await callValidator(validateAccessToken, ipadToken)).status, 403, 'iPad session revoked');
    assert.equal((await callValidator(validateAccessToken, phoneToken)).status, 200, 'phone still signed in');
    assert.deepEqual(tokensOf(7), [`phone@${PHONE_ID}`], 'phone still gets pushes');

    // A token whose session field is missing never validates (no fallback to "any session").
    const forged = jwt.sign({ id: 7, email: 'm@example.com' }, process.env.JWT_ACCESS_SECRET);
    assert.equal((await callValidator(validateAccessToken, forged)).status, 403);
    assert.equal((await callValidator(validateAccessTokenOrGuest, forged)).status, 403);

    // ── LEGACY build: dvToken-only sign-in, validation and logout as before ──────────
    const legacyToken = await openAppSession({ userId: 9, claims: { id: 9, email: 'old@example.com' }, identity: idLegacy });
    assert.equal(jwt.decode(legacyToken).dvToken, FCM('old'));
    assert.equal(jwt.decode(legacyToken).deviceId, undefined);
    assert.equal((await callValidator(validateAccessToken, legacyToken)).status, 200);
    assert.deepEqual(tokensOf(9), ['old@null']);
    await saveCurrentToken(9, FCM('rotated'), null); // legacy rotation report
    await endAppSession(jwt.decode(legacyToken), { currentPushToken: FCM('rotated') });
    assert.equal((await callValidator(validateAccessToken, legacyToken)).status, 403);
    assert.deepEqual(tokensOf(9), [], 'legacy logout forgets the sign-in and current tokens');

    // ── LEGACY session refreshed by an updated app (/agent/session with deviceId): the
    // session moves to the install id and the old field ends; no new sign-in needed. ──
    const oldToken = await openAppSession({ userId: 11, claims: { id: 11 }, identity: resolveSessionIdentity({ dvToken: FCM('v1') }) });
    const upgrade = identityOfSession(jwt.decode(oldToken), { deviceId: IPAD, dvToken: '' });
    assert.equal(upgrade.field, IPAD);
    assert.equal(upgrade.replacesField, FCM('v1'));
    const newToken = await openAppSession({ userId: 11, claims: { id: 11 }, identity: upgrade });
    assert.deepEqual(Object.keys(redis.get('id-11')), [IPAD], 'legacy field dropped');
    assert.equal((await callValidator(validateAccessToken, oldToken)).status, 403);
    assert.equal((await callValidator(validateAccessToken, newToken)).status, 200);
    assert.equal(jwt.decode(newToken).deviceId, IPAD);
    // An install-id session never moves: the body's deviceId is ignored.
    assert.equal(identityOfSession(jwt.decode(newToken), { deviceId: PHONE }).replacesField, undefined);

    // A sign-in without an identity is a programming error, not a silent token-less session.
    await assert.rejects(openAppSession({ userId: 1, claims: { id: 1 }, identity: null }), /identity is required/);

    console.log('appSession.test.js: all assertions passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
