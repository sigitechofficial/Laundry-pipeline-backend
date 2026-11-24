'use strict';

/**
 * Which app session a sign-in or an access token refers to. Pure (no I/O), so the
 * validators (middlewares/accessToken*.js, utils/socketAuth.js) can use it without loading
 * Redis or the models. Opening and closing sessions: utils/appSession.js, which documents the
 * model (install `deviceId` sessions; LEGACY `dvToken` sessions, deprecated).
 */

const { isValidFcmRegistrationToken } = require('./fcmToken');
const { normalizeFirebaseProjectId } = require('./firebaseProjectId');
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
 * The Firebase project the body's push token belongs to (`firebaseProjectId`), or null when
 * the client does not say (builds from before projects were reported).
 * `valid: false` when present but not a Firebase project id: the token cannot be routed, so
 * the caller drops it (the sign-in itself must not fail over a push detail).
 */
function pushTokenProjectOf(body) {
    try {
        return { valid: true, projectId: normalizeFirebaseProjectId(body && body.firebaseProjectId) };
    } catch (err) {
        return { valid: false, projectId: null, code: err.code };
    }
}

/**
 * Which session a sign-in opens, from the request body's `deviceId` and `dvToken`
 * (plus `firebaseProjectId`, the project that issued the push token).
 *
 * @param {{ deviceId?: string, dvToken?: string, firebaseProjectId?: string }} body
 * @param {{ required?: boolean }} [options] required (default true): refuse a sign-in with
 *   neither. Pass false only where a session is an optional by-product (signup re-submits).
 * @returns {null | {
 *   field: string,          // Redis hash field of this session
 *   claims: object,         // what the JWT carries to find it again
 *   deviceId: string|null,  // the install, null on the legacy path
 *   pushToken: string|null, // a real FCM token to deliver pushes to, if the app has one
 *   firebaseProjectId: string|null, // project that issued pushToken; null = not reported
 *   legacy: boolean,
 * }}
 * A malformed firebaseProjectId never fails the sign-in: the push token is dropped (a token
 * whose project is unknown cannot be routed) and the session opens without one; the app
 * registers it again on its next token report.
 * @throws {ValidationError} deviceId present but not a UUID; or neither given when required.
 */
function resolveSessionIdentity(body, { required = true } = {}) {
    const rawDeviceId = trimmed(body && body.deviceId);
    const dvToken = trimmed(body && body.dvToken);
    let pushToken = isValidFcmRegistrationToken(dvToken) ? dvToken : null;
    let firebaseProjectId = null;
    if (pushToken) {
        const reported = pushTokenProjectOf(body);
        if (reported.valid) {
            firebaseProjectId = reported.projectId;
        } else {
            console.warn(`[session] push token dropped at sign-in: firebaseProjectId rejected (${reported.code})`);
            pushToken = null;
        }
    }

    if (rawDeviceId) {
        const deviceId = normalizeDeviceId(rawDeviceId);
        if (!deviceId) {
            throw new ValidationError('deviceId must be a UUID', { code: DEVICE_ID_ERROR.INVALID });
        }
        return { field: deviceId, claims: { deviceId }, deviceId, pushToken, firebaseProjectId, legacy: false };
    }

    // LEGACY (deprecated): builds without deviceId identify the session by dvToken.
    if (dvToken) {
        return { field: dvToken, claims: { dvToken }, deviceId: null, pushToken, firebaseProjectId, legacy: true };
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
    const firebaseProjectId = body && body.firebaseProjectId;
    const deviceId = normalizeDeviceId(sessionClaims && sessionClaims.deviceId);
    if (deviceId) return resolveSessionIdentity({ deviceId, dvToken: body && body.dvToken, firebaseProjectId });

    const legacyField = trimmed(sessionClaims && sessionClaims.dvToken);
    if (trimmed(body && body.deviceId)) {
        const identity = resolveSessionIdentity({ deviceId: body.deviceId, dvToken: body.dvToken, firebaseProjectId });
        return legacyField ? { ...identity, replacesField: legacyField } : identity;
    }
    return resolveSessionIdentity({ dvToken: trimmed(body && body.dvToken) || legacyField, firebaseProjectId });
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
    pushTokenProjectOf,
};
