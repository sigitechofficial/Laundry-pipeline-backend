'use strict';

/**
 * Who a customer social sign-in (Google / Apple / Facebook) really is.
 *
 * The apps and the website sign in with Firebase Auth first (signInWithCredential /
 * signInWithPopup) and send the Firebase ID token of that sign-in as `firebaseIdToken`, with the
 * Firebase project it belongs to as `firebaseProjectId`. The identity is taken ONLY from the
 * verified token, never from the request body:
 *  - the token must be present (builds that send none are refused: they cannot prove anything);
 *  - it must be issued by one of the Firebase projects this server holds
 *    (utils/firebaseProjects.js: primary `justdrycleansltd`, legacy `laundry-app-bf43c`), picked
 *    by the token's audience; a reported `firebaseProjectId` must name that same project;
 *  - it is verified by Firebase Admin for that project, including revocation and disabled users
 *    (`verifyIdToken(token, true)`);
 *  - the sign-in provider must be the one the client says it used (google → google.com,
 *    apple → apple.com, facebook → facebook.com);
 *  - the email is the token's, and Firebase must report it verified (`email_verified`; Apple
 *    private-relay addresses count when Firebase marks them verified).
 * Any failure is a 401 with a `code` (SOCIAL_AUTH_ERROR); a failure to reach Firebase is a 503,
 * never a pass.
 *
 * Dependencies are injected so the rules are unit-testable (tests/customerSocialSignIn.test.js).
 */

const {
    UnauthorizedError,
    ValidationError,
    UniversalHttpError,
    StatusCodes,
} = require('../../middlewares/universalErrorHandler');
const { FIREBASE_PROJECT_ERROR, normalizeFirebaseProjectId } = require('../../utils/firebaseProjectId');

/** signedFrom (what the clients send) → the Firebase `sign_in_provider` it must match. */
const SOCIAL_SIGN_IN_PROVIDERS = Object.freeze({
    google: 'google.com',
    apple: 'apple.com',
    facebook: 'facebook.com',
});

const PROVIDER_LABELS = Object.freeze({ google: 'Google', apple: 'Apple', facebook: 'Facebook' });

const SOCIAL_AUTH_ERROR = Object.freeze({
    TOKEN_REQUIRED: 'SOCIAL_TOKEN_REQUIRED',
    TOKEN_INVALID: 'SOCIAL_TOKEN_INVALID',
    PROJECT_UNKNOWN: 'SOCIAL_TOKEN_PROJECT_UNKNOWN',
    PROVIDER_MISMATCH: 'SOCIAL_PROVIDER_MISMATCH',
    EMAIL_UNVERIFIED: 'SOCIAL_EMAIL_UNVERIFIED',
    VERIFY_UNAVAILABLE: 'SOCIAL_TOKEN_VERIFY_UNAVAILABLE',
});

/** Firebase Admin answers that mean "this token does not prove a sign-in" (401, not 503). */
const REJECTED_TOKEN_CODES = new Set([
    'auth/argument-error',
    'auth/invalid-argument',
    'auth/invalid-id-token',
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/user-disabled',
    'auth/user-not-found',
]);

function isSocialSignIn(signedFrom) {
    return typeof signedFrom === 'string' && Object.prototype.hasOwnProperty.call(SOCIAL_SIGN_IN_PROVIDERS, signedFrom);
}

function unauthorized(code, message) {
    return new UnauthorizedError(message, { code });
}

/**
 * The `aud` claim of a JWT, read WITHOUT verifying it — only to choose which project's Admin app
 * verifies the token (Firebase Admin then checks the signature, issuer and that `aud` is that
 * project). Null when the value is not a JWT.
 */
function unverifiedAudience(token) {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload && typeof payload.aud === 'string' && payload.aud ? payload.aud : null;
    } catch (_) {
        return null;
    }
}

/**
 * @param {{ projects?: { isConfiguredProject(id: string): boolean, authFor(id: string): { verifyIdToken(t: string, checkRevoked: boolean): Promise<object> } } }} [deps]
 *   defaults to utils/firebaseProjects.js
 */
function createSocialIdentityVerifier(deps = {}) {
    const projects = deps.projects || require('../../utils/firebaseProjects');

    /**
     * @param {{ signedFrom: string, firebaseIdToken?: string, firebaseProjectId?: string }} input
     * @returns {Promise<{ email: string, uid: string, firebaseProjectId: string, signInProvider: string }>}
     */
    async function verifySocialSignIn({ signedFrom, firebaseIdToken, firebaseProjectId }) {
        if (!isSocialSignIn(signedFrom)) {
            throw new ValidationError('Unsupported sign-in method');
        }
        const label = PROVIDER_LABELS[signedFrom];
        const signInAgain = `Please sign in with ${label} again.`;
        const updateApp = 'Please update the app to the latest version and sign in again.';

        const token = typeof firebaseIdToken === 'string' ? firebaseIdToken.trim() : '';
        if (!token) {
            throw unauthorized(
                SOCIAL_AUTH_ERROR.TOKEN_REQUIRED,
                `${label} sign-in could not be verified. ${updateApp}`
            );
        }

        let reportedProject;
        try {
            reportedProject = normalizeFirebaseProjectId(firebaseProjectId);
        } catch (err) {
            throw new ValidationError(err.message, { code: FIREBASE_PROJECT_ERROR.INVALID });
        }

        const audience = unverifiedAudience(token);
        if (!audience) {
            throw unauthorized(SOCIAL_AUTH_ERROR.TOKEN_INVALID, `Your ${label} sign-in could not be verified. ${signInAgain}`);
        }
        if (reportedProject && reportedProject !== audience) {
            throw unauthorized(SOCIAL_AUTH_ERROR.TOKEN_INVALID, `Your ${label} sign-in could not be verified. ${signInAgain}`);
        }
        if (!projects.isConfiguredProject(audience)) {
            throw unauthorized(SOCIAL_AUTH_ERROR.PROJECT_UNKNOWN, `Your ${label} sign-in could not be verified. ${updateApp}`);
        }

        let decoded;
        try {
            decoded = await projects.authFor(audience).verifyIdToken(token, true);
        } catch (err) {
            if (err && REJECTED_TOKEN_CODES.has(err.code)) {
                const expired = err.code === 'auth/id-token-expired';
                throw unauthorized(
                    SOCIAL_AUTH_ERROR.TOKEN_INVALID,
                    expired
                        ? `Your ${label} sign-in has expired. ${signInAgain}`
                        : `Your ${label} sign-in could not be verified. ${signInAgain}`
                );
            }
            console.error('[socialSignIn] Firebase ID token verification unavailable:', err && (err.code || err.message));
            throw new UniversalHttpError(
                'Sign-in is temporarily unavailable. Please try again in a moment.',
                StatusCodes.SERVICE_UNAVAILABLE,
                { code: SOCIAL_AUTH_ERROR.VERIFY_UNAVAILABLE }
            );
        }

        // Firebase Admin already requires aud === the project; checked again so a mis-wired
        // Admin app can never let another project's token through.
        if (!decoded || decoded.aud !== audience || typeof decoded.uid !== 'string' || !decoded.uid) {
            throw unauthorized(SOCIAL_AUTH_ERROR.TOKEN_INVALID, `Your ${label} sign-in could not be verified. ${signInAgain}`);
        }

        const signInProvider = decoded.firebase && decoded.firebase.sign_in_provider;
        if (signInProvider !== SOCIAL_SIGN_IN_PROVIDERS[signedFrom]) {
            throw unauthorized(
                SOCIAL_AUTH_ERROR.PROVIDER_MISMATCH,
                `This sign-in was not made with ${label}. ${updateApp}`
            );
        }

        const email = typeof decoded.email === 'string' ? decoded.email.trim() : '';
        if (!email || decoded.email_verified !== true) {
            throw unauthorized(
                SOCIAL_AUTH_ERROR.EMAIL_UNVERIFIED,
                `Your ${label} account has no verified email address. Please verify it with ${label}, or sign up with email and password.`
            );
        }

        return { email, uid: decoded.uid, firebaseProjectId: audience, signInProvider };
    }

    return { verifySocialSignIn };
}

module.exports = {
    SOCIAL_SIGN_IN_PROVIDERS,
    SOCIAL_AUTH_ERROR,
    isSocialSignIn,
    unverifiedAudience,
    createSocialIdentityVerifier,
};
