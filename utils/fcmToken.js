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

module.exports = {
    isValidFcmRegistrationToken,
    INVALID_FCM_PLACEHOLDERS,
};
