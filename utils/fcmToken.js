'use strict';

/** Placeholders the admin/customer clients send when FCM is unavailable. */
const INVALID_FCM_PLACEHOLDERS = new Set([
    'no-fcm-token',
    'null',
    'undefined',
    'none',
    'n/a',
]);

/**
 * True if the string looks like a real FCM registration token (not a session placeholder).
 * Web tokens are long; Android often contains ":APA91b".
 */
function isValidFcmRegistrationToken(token) {
    if (typeof token !== 'string') return false;
    const t = token.trim();
    if (!t || t.length < 80) return false;
    if (INVALID_FCM_PLACEHOLDERS.has(t.toLowerCase())) return false;
    if (/^web-\d+-/i.test(t) && t.length < 40) return false;
    // Reject obvious placeholders even if long
    if (/^no-fcm/i.test(t)) return false;
    return true;
}

/** FCM errors that mean the token itself is dead: safe (and required) to delete it. */
const STALE_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered', // UNREGISTERED: app uninstalled / token rotated
    'messaging/invalid-registration-token', // malformed token string
]);

/**
 * True only when an FCM send failure proves the token is unusable for good.
 *
 * `messaging/invalid-argument` (HTTP 400 INVALID_ARGUMENT) also covers problems that are
 * not the token's fault: an invalid payload, or APNs rejecting the request ("Invalid APNs
 * request" — APNs key/environment, simulator tokens). Deleting on those would wipe every
 * user's working tokens after one bad deploy, so it counts only when FCM says the
 * registration token is what is invalid. Everything else (quota, auth, APNs config,
 * sender mismatch) is a server-side problem: keep the token and surface the error.
 */
function isStaleTokenError(error) {
    const code = error && error.code;
    if (STALE_TOKEN_CODES.has(code)) return true;
    if (code === 'messaging/invalid-argument') {
        return /registration token/i.test(String((error && error.message) || ''));
    }
    return false;
}

module.exports = {
    isValidFcmRegistrationToken,
    isStaleTokenError,
    INVALID_FCM_PLACEHOLDERS,
};
