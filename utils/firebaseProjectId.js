'use strict';

/**
 * `firebaseProjectId` as clients send it: the Firebase project their FCM token and Firebase
 * Auth belong to (`Firebase.app().options.projectId` in the apps, the web config's projectId
 * on the website/admin panel). Pure — no config, no I/O — so request parsing and the session
 * validators can use it. Which projects this server holds: utils/firebaseProjects.js.
 */

/** Firebase/GCP project id: 6–30 chars, lower-case letters, digits, hyphens. */
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const FIREBASE_PROJECT_ERROR = Object.freeze({
  INVALID: 'INVALID_FIREBASE_PROJECT_ID',
  NOT_CONFIGURED: 'FIREBASE_PROJECT_NOT_CONFIGURED',
});

/**
 * Canonical project id, or null when absent/blank (clients from before projects were reported).
 * @throws {Error & { code: 'INVALID_FIREBASE_PROJECT_ID' }} present but not a project id
 */
function normalizeFirebaseProjectId(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    const err = new Error('firebaseProjectId must be a string');
    err.code = FIREBASE_PROJECT_ERROR.INVALID;
    throw err;
  }
  const id = value.trim().toLowerCase();
  if (!id) return null;
  if (!PROJECT_ID_RE.test(id)) {
    const err = new Error('firebaseProjectId is not a valid Firebase project id');
    err.code = FIREBASE_PROJECT_ERROR.INVALID;
    throw err;
  }
  return id;
}

module.exports = {
  FIREBASE_PROJECT_ERROR,
  normalizeFirebaseProjectId,
};
