'use strict';

/**
 * firebaseProjectId as clients report it: parsing (utils/firebaseProjectId.js), the sign-in
 * identity (utils/sessionIdentity.js) and push-token reports (utils/pushTokenProject.js).
 */

const assert = require('assert/strict');
const path = require('path');

// Server holds two projects (stub of utils/firebaseProjects.js).
const projectsPath = require.resolve(path.join(__dirname, '..', 'utils', 'firebaseProjects'));
require.cache[projectsPath] = {
  id: projectsPath,
  filename: projectsPath,
  loaded: true,
  exports: {
    acceptClientProject(id) {
      if (!id || id === 'new-project' || id === 'old-project') return id || null;
      const err = new Error(`Firebase project ${id} is not configured on this server`);
      err.code = 'FIREBASE_PROJECT_NOT_CONFIGURED';
      throw err;
    },
  },
};

const { normalizeFirebaseProjectId } = require('../utils/firebaseProjectId');
const { resolveSessionIdentity, identityOfSession } = require('../utils/sessionIdentity');
const { reportedPushProject } = require('../utils/pushTokenProject');

const FCM = 'f'.repeat(120);
const DEVICE = '0b9f6f1e-2c43-4d55-9a65-1f0e8c1d2a3b';

assert.equal(normalizeFirebaseProjectId(undefined), null);
assert.equal(normalizeFirebaseProjectId('  '), null);
assert.equal(normalizeFirebaseProjectId(' JustDryCleansLtd '), 'justdrycleansltd');
assert.equal(normalizeFirebaseProjectId('laundry-app-bf43c'), 'laundry-app-bf43c');
for (const bad of ['ab', 'has space', 'Bad_Underscore', '-leading', 'x'.repeat(31), 42]) {
  assert.throws(() => normalizeFirebaseProjectId(bad), (e) => e.code === 'INVALID_FIREBASE_PROJECT_ID', String(bad));
}

// Sign-in identity carries the project of its push token.
assert.equal(resolveSessionIdentity({ deviceId: DEVICE, dvToken: FCM, firebaseProjectId: 'new-project' }).firebaseProjectId, 'new-project');
assert.equal(resolveSessionIdentity({ deviceId: DEVICE, dvToken: FCM }).firebaseProjectId, null, 'older builds: unclassified');
assert.equal(resolveSessionIdentity({ dvToken: FCM, firebaseProjectId: 'old-project' }).firebaseProjectId, 'old-project');
assert.equal(resolveSessionIdentity({ deviceId: DEVICE, firebaseProjectId: 'new-project' }).firebaseProjectId, null, 'no push token: no project');
assert.throws(() => resolveSessionIdentity({ deviceId: DEVICE, dvToken: FCM, firebaseProjectId: 'not valid!' }), (e) => e.statusCode === 400 || e.status === 400 || /valid Firebase project/.test(e.message));
assert.equal(identityOfSession({ deviceId: DEVICE }, { dvToken: FCM, firebaseProjectId: 'new-project' }).firebaseProjectId, 'new-project', '/agent/session refresh');

// Push-token reports are checked against the configured projects.
assert.deepEqual(reportedPushProject({ firebaseProjectId: 'new-project' }), { ok: true, firebaseProjectId: 'new-project' });
assert.deepEqual(reportedPushProject({}), { ok: true, firebaseProjectId: null });
assert.equal(reportedPushProject({ firebaseProjectId: 'other-project' }).error, 'FIREBASE_PROJECT_NOT_CONFIGURED');
assert.equal(reportedPushProject({ firebaseProjectId: 'Not Valid' }).error, 'INVALID_FIREBASE_PROJECT_ID');

console.log('firebaseProjectId.test.js: all assertions passed');
