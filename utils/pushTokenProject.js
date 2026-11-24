'use strict';

/**
 * The Firebase project a push-token report (POST /customer/deviceToken, /agent/deviceToken,
 * admin FCM refresh) says its token belongs to: `firebaseProjectId` in the body, checked
 * against the projects this server holds (utils/firebaseProjects.js). Absent = null (builds
 * from before projects were reported; routed legacy-first, utils/fcmRouting.js).
 */

const { normalizeFirebaseProjectId } = require('./firebaseProjectId');

/**
 * @param {object} body request body
 * @returns {{ ok: true, firebaseProjectId: string|null } | { ok: false, error: string, message: string }}
 */
function reportedPushProject(body) {
  try {
    const projectId = normalizeFirebaseProjectId(body && body.firebaseProjectId);
    const { acceptClientProject } = require('./firebaseProjects');
    return { ok: true, firebaseProjectId: acceptClientProject(projectId) };
  } catch (err) {
    if (!err.code) throw err;
    return { ok: false, error: err.code, message: err.message };
  }
}

module.exports = { reportedPushProject };
