'use strict';

const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const {
    SOCKET_AUTH_MODE,
    SOCKET_AUTH_ERROR,
    resolveSocketAuthMode,
    parseSocketPayload,
    extractSocketToken,
    normalizeRoomId,
    createSocketTokenVerifier,
    authorizeRoomJoin,
    resolveSocketActorId,
} = require('./socketAuth');

const SECRET = 'test-socket-auth-secret-not-for-prod';
const sign = (payload, secret = SECRET) => jwt.sign(payload, secret);

// Agent session exactly as authService mints it: JWT + Redis hash id-<id> { [dvToken]: token }.
function session({ id, dvToken = 'device-1', extra = {} }) {
    const token = sign({ id, email: `u${id}@example.com`, dvToken, ...extra });
    return { token, redis: { [`id-${id}`]: { [dvToken]: token } } };
}

function verifierFor(redis, { blocked = [] } = {}) {
    return createSocketTokenVerifier({
        verifyJwt: (token) => jwt.verify(token, SECRET),
        async isUserBlocked(userId) {
            return blocked.includes(Number(userId));
        },
        async loadSessionTokens(userId) {
            return redis[`id-${userId}`] || {};
        },
    });
}

async function rejectsWith(promise, code) {
    await assert.rejects(promise, (err) => err.code === code);
}

async function run() {
    // ── mode ──────────────────────────────────────────────────────────────
    assert.equal(resolveSocketAuthMode({}), SOCKET_AUTH_MODE.OPTIONAL);
    assert.equal(resolveSocketAuthMode({ SOCKET_AUTH_MODE: ' Required ' }), SOCKET_AUTH_MODE.REQUIRED);
    assert.equal(resolveSocketAuthMode({ SOCKET_AUTH_MODE: 'yes' }), SOCKET_AUTH_MODE.OPTIONAL);

    // ── payload / token extraction ────────────────────────────────────────
    assert.deepEqual(parseSocketPayload('{"userId":"7"}'), { userId: '7' });
    assert.deepEqual(parseSocketPayload({ userId: 7 }), { userId: 7 });
    assert.deepEqual(parseSocketPayload(null), {});
    assert.deepEqual(parseSocketPayload('"7"'), {});
    assert.throws(() => parseSocketPayload('{not json'));

    assert.equal(extractSocketToken({ accessToken: 'p1', token: 'p2' }, { auth: { token: 'a' } }), 'p1');
    assert.equal(extractSocketToken({ token: 'p2' }, {}), 'p2');
    assert.equal(extractSocketToken({ accessToken: '   ' }, { auth: { token: 'a1' } }), 'a1');
    assert.equal(extractSocketToken({}, { headers: { accesstoken: 'h1' } }), 'h1');
    assert.equal(extractSocketToken({}, { headers: { 'x-access-token': 'h2' } }), 'h2');
    assert.equal(extractSocketToken({}, { headers: { authorization: 'Bearer b1 ' } }), 'b1');
    assert.equal(extractSocketToken({}, { headers: { authorization: 'Basic b1' } }), null);
    assert.equal(extractSocketToken({ userId: '7' }, undefined), null);

    assert.equal(normalizeRoomId(7), '7');
    assert.equal(normalizeRoomId(' 7 '), '7');
    for (const bad of [null, undefined, '', 'null', 'undefined', '  ']) {
        assert.equal(normalizeRoomId(bad), null, `room id ${JSON.stringify(bad)} must be rejected`);
    }

    // ── token verifier (mirrors middlewares/accessToken.js) ───────────────
    const owner = session({ id: 7 });
    const verify = verifierFor(owner.redis);
    const user = await verify(owner.token);
    assert.equal(user.id, 7);

    await rejectsWith(verify(sign({ id: 7, dvToken: 'device-1' }, 'wrong-secret')), SOCKET_AUTH_ERROR.INVALID_TOKEN);
    await rejectsWith(verify('not-a-jwt'), SOCKET_AUTH_ERROR.INVALID_TOKEN);
    await rejectsWith(verify(sign({ guest: true, jti: 'g-1' })), SOCKET_AUTH_ERROR.INVALID_TOKEN);
    // Logged out: Redis session gone.
    await rejectsWith(verifierFor({})(owner.token), SOCKET_AUTH_ERROR.INVALID_TOKEN);
    // Token for a device that has no session.
    await rejectsWith(verify(sign({ id: 7, dvToken: 'other-device' })), SOCKET_AUTH_ERROR.INVALID_TOKEN);
    // Token without dvToken never matches a session.
    await rejectsWith(verify(sign({ id: 7 })), SOCKET_AUTH_ERROR.INVALID_TOKEN);
    // Stored session belongs to someone else (corrupt / tampered hash).
    const intruder = session({ id: 8 });
    await rejectsWith(
        verifierFor({ 'id-7': { 'device-1': intruder.token } })(owner.token),
        SOCKET_AUTH_ERROR.INVALID_TOKEN
    );
    await rejectsWith(verifierFor(owner.redis, { blocked: [7] })(owner.token), SOCKET_AUTH_ERROR.ACCOUNT_BLOCKED);

    // ── room join ─────────────────────────────────────────────────────────
    const join = (payload, mode = SOCKET_AUTH_MODE.OPTIONAL, handshake = {}) =>
        authorizeRoomJoin({ payload, handshake, mode, verifyToken: verify });

    let result = await join({ userId: '7', userTypeId: 4, accessToken: owner.token });
    assert.deepEqual(
        { ok: result.ok, roomId: result.roomId, authenticated: result.authenticated },
        { ok: true, roomId: '7', authenticated: true }
    );

    result = await join({ accessToken: owner.token }, SOCKET_AUTH_MODE.REQUIRED);
    assert.equal(result.ok, true);
    assert.equal(result.roomId, '7', 'room comes from the token when userId is omitted');

    result = await join({ userId: '7' }, SOCKET_AUTH_MODE.REQUIRED, { auth: { token: owner.token } });
    assert.equal(result.ok, true, 'handshake auth token is accepted');

    // The attack: valid token for 7, asks for someone else's room.
    result = await join({ userId: '8', accessToken: owner.token });
    assert.equal(result.ok, false);
    assert.equal(result.code, SOCKET_AUTH_ERROR.ROOM_FORBIDDEN);

    // A presented-but-bad token never falls back to the legacy path.
    result = await join({ userId: '8', accessToken: 'garbage' });
    assert.equal(result.ok, false);
    assert.equal(result.code, SOCKET_AUTH_ERROR.INVALID_TOKEN);

    result = await join({ userId: '7', accessToken: owner.token }, SOCKET_AUTH_MODE.OPTIONAL);
    assert.equal(result.ok, true);

    // Legacy token-less clients: allowed only in optional mode.
    result = await join({ userId: '8', userTypeId: 4 });
    assert.deepEqual(
        { ok: result.ok, roomId: result.roomId, authenticated: result.authenticated },
        { ok: true, roomId: '8', authenticated: false }
    );
    result = await join({ userId: 'null' });
    assert.equal(result.code, SOCKET_AUTH_ERROR.INVALID_USER_ID);
    result = await join({ userId: '8' }, SOCKET_AUTH_MODE.REQUIRED);
    assert.equal(result.ok, false);
    assert.equal(result.code, SOCKET_AUTH_ERROR.AUTH_REQUIRED);

    // ── actor id for agentAcceptOrder ─────────────────────────────────────
    const authed = { authenticated: true, userId: '7' };
    assert.deepEqual(
        resolveSocketActorId({ socketData: authed, requestedUserId: '7', mode: SOCKET_AUTH_MODE.OPTIONAL }),
        { ok: true, userId: '7' }
    );
    assert.deepEqual(
        resolveSocketActorId({ socketData: authed, requestedUserId: undefined, mode: SOCKET_AUTH_MODE.OPTIONAL }),
        { ok: true, userId: '7' }
    );
    assert.equal(
        resolveSocketActorId({ socketData: authed, requestedUserId: 8, mode: SOCKET_AUTH_MODE.OPTIONAL }).code,
        SOCKET_AUTH_ERROR.ROOM_FORBIDDEN
    );
    assert.deepEqual(
        resolveSocketActorId({ socketData: { authenticated: false, userId: '8' }, requestedUserId: '8', mode: SOCKET_AUTH_MODE.OPTIONAL }),
        { ok: true, userId: '8' }
    );
    assert.equal(
        resolveSocketActorId({ socketData: {}, requestedUserId: '8', mode: SOCKET_AUTH_MODE.REQUIRED }).code,
        SOCKET_AUTH_ERROR.AUTH_REQUIRED
    );
    assert.equal(
        resolveSocketActorId({ socketData: {}, requestedUserId: 'null', mode: SOCKET_AUTH_MODE.OPTIONAL }).code,
        SOCKET_AUTH_ERROR.INVALID_USER_ID
    );

    console.log('socketAuth.test.js: ok');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
