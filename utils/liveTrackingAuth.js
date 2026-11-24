/**
 * Firebase Auth custom tokens for RTDB live-tracking security rules.
 * UID format: customer_{id} | agent_{id}
 * Claims: { role, appUserId }
 *
 * A custom token only signs in to the Firebase project that minted it, so it is minted by
 * the project the requesting app is on (its `firebaseProjectId`; apps that do not send one
 * are on the legacy project — firebaseProjects.clientProjectFor), and the response names
 * that project's RTDB.
 */

const firebaseProjects = require('./firebaseProjects');

function firebaseUidForRole(role, appUserId) {
  return `${role}_${appUserId}`;
}

/**
 * @param {'customer'|'agent'} role
 * @param {number|string} appUserId
 * @param {{ firebaseProjectId?: string|null }} [options] project the app is on (normalised)
 * @returns {Promise<{ token: string, uid: string, firebaseProjectId: string, databaseURL: string, expiresInSec: number }>}
 */
async function createLiveTrackingCustomToken(role, appUserId, { firebaseProjectId = null } = {}) {
  const project = firebaseProjects.clientProjectFor(firebaseProjectId);
  if (!project) {
    const err = new Error(
      firebaseProjectId
        ? `Firebase project ${firebaseProjectId} is not configured on this server`
        : 'Firebase Admin is not configured'
    );
    err.code = firebaseProjectId
      ? firebaseProjects.FIREBASE_PROJECT_ERROR.NOT_CONFIGURED
      : 'FIREBASE_NOT_CONFIGURED';
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
  const token = await firebaseProjects.authFor(project.projectId).createCustomToken(uid, {
    role: normalizedRole,
    appUserId: id,
  });

  return {
    token,
    uid,
    firebaseProjectId: project.projectId,
    databaseURL: project.databaseURL,
    expiresInSec: 3600,
  };
}

module.exports = {
  firebaseUidForRole,
  createLiveTrackingCustomToken,
};
