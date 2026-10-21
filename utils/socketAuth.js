'use strict';

/**
 * Socket.IO room auth.
 *
 * Rooms are keyed by users.id and carry private events (AcceptedOrder,
 * printJobCreated, staffJobAssigned, cashRemittanceUpdate, ...), so a socket may
 * only join the room of the user its access token belongs to.
 *
 * Token check mirrors middlewares/accessToken.js (REST): JWT signature →
 * blocked-account check → Redis hash `id-<id>` keyed by dvToken → verify the
 * stored session token. Guest tokens have no users.id and never get a room.
 *
 * Token sources (first hit wins):
 *   payload.accessToken | payload.token          (joinRoom / re-connect JSON)
 *   handshake.auth.accessToken | .token          (io(url, { auth }))
 *   handshake.headers.accesstoken | x-access-token | Authorization: Bearer
 *
 * Rollout — SOCKET_AUTH_MODE:
 *   optional (default) — a presented token is always verified and a bad one is
 *     refused, but token-less legacy clients (agent app builds before the
 *     token was added) may still join the room they name. Logged as
 *     [socketAuth] legacy so adoption can be tracked.
 *   required — token-less joins are refused. Flip once legacy logs stop.
 */

const SOCKET_AUTH_MODE = Object.freeze({
    OPTIONAL: 'optional',
    REQUIRED: 'required',
});

const SOCKET_AUTH_ERROR = Object.freeze({
    INVALID_USER_ID: 'INVALID_USER_ID',
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    INVALID_TOKEN: 'INVALID_TOKEN',
    ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
    ROOM_FORBIDDEN: 'ROOM_FORBIDDEN',
});

class SocketAuthError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SocketAuthError';
        this.code = code;
    }
}

function resolveSocketAuthMode(env = process.env) {
    const raw = String(env.SOCKET_AUTH_MODE || '').trim().toLowerCase();
    return raw === SOCKET_AUTH_MODE.REQUIRED
        ? SOCKET_AUTH_MODE.REQUIRED
        : SOCKET_AUTH_MODE.OPTIONAL;
}

/** Clients send a JSON string; accept a plain object too. */
function parseSocketPayload(message) {
    if (message == null) return {};
    if (typeof message === 'string') {
        const parsed = JSON.parse(message);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    return typeof message === 'object' ? message : {};
}

function nonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function extractSocketToken(payload, handshake) {
    const auth = handshake?.auth || {};
    const headers = handshake?.headers || {};

    const direct =
        nonEmptyString(payload?.accessToken) ||
        nonEmptyString(payload?.token) ||
        nonEmptyString(auth.accessToken) ||
        nonEmptyString(auth.token) ||
        nonEmptyString(headers.accesstoken) ||
        nonEmptyString(headers['x-access-token']);
    if (direct) return direct;

    const authHeader = headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return nonEmptyString(authHeader.slice(7));
    }
    return null;
}

/** Same guard joinRoom always had: reject null / 'null' / 'undefined' ids. */
function normalizeRoomId(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!str || str === 'null' || str === 'undefined') return null;
    return str;
}

const defaultDeps = {
    verifyJwt(token) {
        const { verify } = require('jsonwebtoken');
        return verify(token, process.env.JWT_ACCESS_SECRET);
    },
    async isUserBlocked(userId) {
        const id = Number(userId);
        if (!Number.isFinite(id) || id <= 0) return false;
        const { users } = require('../models');
        const { isUserBlocked } = require('./accountBlocked');
        const row = await users.findByPk(id, { attributes: ['id', 'status'] });
        return Boolean(row && isUserBlocked(row.status));
    },
    async loadSessionTokens(userId) {
        const redisCli = require('../redis/redis');
        return redisCli.hGetAll(`id-${userId}`);
    },
};

/**
 * @returns {(token: string) => Promise<object>} resolves to the session user
 *   (same object REST puts on req.user); rejects with SocketAuthError.
 */
function createSocketTokenVerifier(overrides = {}) {
    const deps = { ...defaultDeps, ...overrides };

    return async function verifySocketAccessToken(token) {
        let decoded;
        try {
            decoded = deps.verifyJwt(token);
        } catch (_err) {
            throw new SocketAuthError(SOCKET_AUTH_ERROR.INVALID_TOKEN, 'Invalid access token');
        }
        if (!decoded || decoded.guest === true || decoded.id == null) {
            throw new SocketAuthError(SOCKET_AUTH_ERROR.INVALID_TOKEN, 'Invalid access token');
        }

        if (await deps.isUserBlocked(decoded.id)) {
            throw new SocketAuthError(SOCKET_AUTH_ERROR.ACCOUNT_BLOCKED, 'Account blocked');
        }

        const sessions = await deps.loadSessionTokens(decoded.id);
        const stored = sessions && decoded.dvToken ? sessions[decoded.dvToken] : null;
        if (!stored) {
            throw new SocketAuthError(SOCKET_AUTH_ERROR.INVALID_TOKEN, 'Session not found');
        }

        let user;
        try {
            user = deps.verifyJwt(stored);
        } catch (_err) {
            throw new SocketAuthError(SOCKET_AUTH_ERROR.INVALID_TOKEN, 'Session not valid');
        }
        if (!user || user.id == null || String(user.id) !== String(decoded.id)) {
            throw new SocketAuthError(SOCKET_AUTH_ERROR.INVALID_TOKEN, 'Session not valid');
        }
        return user;
    };
}

/**
 * Decide which room a joinRoom / re-connect may join.
 * @returns {Promise<{ ok: true, roomId: string, authenticated: boolean, user: object|null }
 *   | { ok: false, code: string, message: string }>}
 */
async function authorizeRoomJoin({ payload, handshake, mode, verifyToken }) {
    const requestedRoomId = normalizeRoomId(payload?.userId);
    const token = extractSocketToken(payload, handshake);

    if (token) {
        let user;
        try {
            user = await verifyToken(token);
        } catch (err) {
            return {
                ok: false,
                code: err.code || SOCKET_AUTH_ERROR.INVALID_TOKEN,
                message: 'Invalid or expired session. Please sign in again.',
            };
        }
        const roomId = String(user.id);
        if (requestedRoomId && requestedRoomId !== roomId) {
            return {
                ok: false,
                code: SOCKET_AUTH_ERROR.ROOM_FORBIDDEN,
                message: 'Access token does not match the requested user.',
            };
        }
        return { ok: true, roomId, authenticated: true, user };
    }

    if (mode === SOCKET_AUTH_MODE.REQUIRED) {
        return {
            ok: false,
            code: SOCKET_AUTH_ERROR.AUTH_REQUIRED,
            message: 'Access token required. Please update the app and sign in again.',
        };
    }

    if (!requestedRoomId) {
        return {
            ok: false,
            code: SOCKET_AUTH_ERROR.INVALID_USER_ID,
            message: 'Invalid user ID. Please authenticate first.',
        };
    }
    return { ok: true, roomId: requestedRoomId, authenticated: false, user: null };
}

/**
 * Actor id for client-initiated actions (agentAcceptOrder). An authenticated
 * socket acts only as its own user; legacy sockets keep the payload id until
 * SOCKET_AUTH_MODE=required.
 * @returns {{ ok: true, userId: string } | { ok: false, code: string, message: string }}
 */
function resolveSocketActorId({ socketData, requestedUserId, mode }) {
    const requested = normalizeRoomId(requestedUserId);

    if (socketData?.authenticated === true && socketData.userId != null) {
        const own = String(socketData.userId);
        if (requested && requested !== own) {
            return {
                ok: false,
                code: SOCKET_AUTH_ERROR.ROOM_FORBIDDEN,
                message: 'Cannot act on behalf of another user.',
            };
        }
        return { ok: true, userId: own };
    }

    if (mode === SOCKET_AUTH_MODE.REQUIRED) {
        return {
            ok: false,
            code: SOCKET_AUTH_ERROR.AUTH_REQUIRED,
            message: 'Join your room with an access token first.',
        };
    }

    if (!requested) {
        return {
            ok: false,
            code: SOCKET_AUTH_ERROR.INVALID_USER_ID,
            message: 'Invalid user ID.',
        };
    }
    return { ok: true, userId: requested };
}

module.exports = {
    SOCKET_AUTH_MODE,
    SOCKET_AUTH_ERROR,
    SocketAuthError,
    resolveSocketAuthMode,
    parseSocketPayload,
    extractSocketToken,
    normalizeRoomId,
    createSocketTokenVerifier,
    authorizeRoomJoin,
    resolveSocketActorId,
};
