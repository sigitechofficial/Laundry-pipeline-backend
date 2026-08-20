/**
 * Firebase Auth custom tokens for RTDB live-tracking security rules.
 * UID format: customer_{id} | agent_{id}
 * Claims: { role, appUserId }
 */

const { getAuth } = require('firebase-admin/auth');
const { ensureFirebaseReady, getFirebaseDatabaseUrl } = require('./notification');

function firebaseUidForRole(role, appUserId) {
  return `${role}_${appUserId}`;
}

/**
 * @param {'customer'|'agent'} role
 * @param {number|string} appUserId
 * @returns {Promise<{ token: string, uid: string, databaseURL: string, expiresInSec: number }>}
 */
async function createLiveTrackingCustomToken(role, appUserId) {
  if (!ensureFirebaseReady()) {
    const err = new Error('Firebase Admin is not configured');
    err.code = 'FIREBASE_NOT_CONFIGURED';
    throw err;
  }

  const normalizedRole = role === 'agent' ? 'agent' : 'customer';
  const id = Number(appUserId);
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('Invalid app user id for tracking token');
    err.code = 'INVALID_USER';
    throw err;
  }

  const uid = firebaseUidForRole(normalizedRole, id);
  const token = await getAuth().createCustomToken(uid, {
    role: normalizedRole,
    appUserId: id,
  });

  return {
    token,
    uid,
    databaseURL: getFirebaseDatabaseUrl(),
    expiresInSec: 3600,
  };
}

module.exports = {
  firebaseUidForRole,
  createLiveTrackingCustomToken,
};
