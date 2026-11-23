'use strict';

/**
 * Which app session a sign-in or an access token refers to. Pure (no I/O), so the
 * validators (middlewares/accessToken*.js, utils/socketAuth.js) can use it without loading
 * Redis or the models. Opening and closing sessions: utils/appSession.js, which documents the
 * model (install `deviceId` sessions; LEGACY `dvToken` sessions, deprecated).
 */

const { isValidFcmRegistrationToken } = require('./fcmToken');
const { ValidationError } = require('../middlewares/universalErrorHandler');

const DEVICE_ID_ERROR = Object.freeze({
    REQUIRED: 'DEVICE_ID_REQUIRED',
    INVALID: 'INVALID_DEVICE_ID',
});

/** RFC 4122 textual form (any version). Apps generate v4. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** Canonical (lower-case) deviceId, or null when `value` is not a UUID. */
function normalizeDeviceId(value) {
    const id = trimmed(value).toLowerCase();
    return UUID_RE.test(id) ? id : null;
}

/**
 * Which session a sign-in opens, from the request body's `deviceId` and `dvToken`.
 *
 * @param {{ deviceId?: string, dvToken?: string }} body
 * @param {{ required?: boolean }} [options] required (default true): refuse a sign-in with
 *   neither. Pass false only where a session is an optional by-product (signup re-submits).
 * @returns {null | {
 *   field: string,          // Redis hash field of this session
 *   claims: object,         // what the JWT carries to find it again
 *   deviceId: string|null,  // the install, null on the legacy path
 *   pushToken: string|null, // a real FCM token to deliver pushes to, if the app has one
 *   legacy: boolean,
 * }}
 * @throws {ValidationError} deviceId present but not a UUID; or neither given when required.
 */
function resolveSessionIdentity(body, { required = true } = {}) {
    const rawDeviceId = trimmed(body && body.deviceId);
    const dvToken = trimmed(body && body.dvToken);
    const pushToken = isValidFcmRegistrationToken(dvToken) ? dvToken : null;

    if (rawDeviceId) {
        const deviceId = normalizeDeviceId(rawDeviceId);
        if (!deviceId) {
            throw new ValidationError('deviceId must be a UUID', { code: DEVICE_ID_ERROR.INVALID });
        }
        return { field: deviceId, claims: { deviceId }, deviceId, pushToken, legacy: false };
    }

    // LEGACY (deprecated): builds without deviceId identify the session by dvToken.
    if (dvToken) {
        return { field: dvToken, claims: { dvToken }, deviceId: null, pushToken, legacy: true };
    }

    if (!required) return null;
    throw new ValidationError('deviceId is required', { code: DEVICE_ID_ERROR.REQUIRED });
}

/**
 * The identity of an already signed-in session, for endpoints that re-issue its access token
 * (agent /session). The install comes from the verified session, never from the body; the
 * body's dvToken is only the app's current push token.
 * LEGACY (deprecated) sessions:
 *  - an app updated to send deviceId moves its session to that install id (`replacesField`
 *    names the legacy field to drop), so updated installs leave the legacy path without
 *    signing in again — the caller already proved the session with its access token;
 *  - otherwise the old behaviour: the body's dvToken, when sent, names the session, else the
 *    one the app signed in with.
 * @param {object} sessionClaims req.user
 * @param {{ deviceId?: string, dvToken?: string }} [body]
 * @returns {object} as resolveSessionIdentity, plus `replacesField` when a legacy session moves
 */
function identityOfSession(sessionClaims, body = {}) {
    const deviceId = normalizeDeviceId(sessionClaims && sessionClaims.deviceId);
    if (deviceId) return resolveSessionIdentity({ deviceId, dvToken: body && body.dvToken });

    const legacyField = trimmed(sessionClaims && sessionClaims.dvToken);
    if (trimmed(body && body.deviceId)) {
        const identity = resolveSessionIdentity({ deviceId: body.deviceId, dvToken: body.dvToken });
        return legacyField ? { ...identity, replacesField: legacyField } : identity;
    }
    return resolveSessionIdentity({ dvToken: trimmed(body && body.dvToken) || legacyField });
}

/**
 * The Redis field of the session an access token belongs to (null if it names none).
 * Tokens minted for deviceId sessions carry `deviceId`; LEGACY tokens carry only `dvToken`.
 */
function sessionFieldOf(claims) {
    if (!claims) return null;
    return trimmed(claims.deviceId) || trimmed(claims.dvToken) || null;
}

module.exports = {
    DEVICE_ID_ERROR,
    normalizeDeviceId,
    resolveSessionIdentity,
    identityOfSession,
    sessionFieldOf,
};
