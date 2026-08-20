'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const notificationPath = require.resolve('../utils/notification');
const firebaseCredentialPath = path.resolve(__dirname, '../firebase.json');

function loadNotification({ credentialFileExists, serviceAccount }) {
  const apps = [];
  const calls = {
    cert: [],
    initializeApp: [],
    messages: [],
  };
  const originalLoad = Module._load;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const originalLog = console.log;
  const originalWarn = console.warn;

  Module._load = function load(request, parent, isMain) {
    if (request === 'firebase-admin/app') {
      return {
        cert(value) {
          calls.cert.push(value);
          return { serviceAccount: value };
        },
        getApps() {
          return apps;
        },
        initializeApp(options) {
          calls.initializeApp.push(options);
          const app = { options };
          apps.push(app);
          return app;
        },
      };
    }
    if (request === 'firebase-admin/messaging') {
      return {
        getMessaging() {
          return {
            async sendEachForMulticast(message) {
              calls.messages.push(message);
              return {
                successCount: message.tokens.length,
                failureCount: 0,
                responses: message.tokens.map((_, index) => ({
                  success: true,
                  messageId: `message-${index}`,
                })),
              };
            },
          };
        },
      };
    }
    if (
      request === '../models' &&
      parent &&
      parent.filename === notificationPath
    ) {
      return { deviceToken: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  fs.existsSync = (candidate) =>
    path.resolve(candidate) === firebaseCredentialPath
      ? credentialFileExists
      : originalExistsSync(candidate);
  fs.readFileSync = (candidate, ...args) =>
    path.resolve(candidate) === firebaseCredentialPath
      ? JSON.stringify(serviceAccount)
      : originalReadFileSync(candidate, ...args);
  console.log = () => {};
  console.warn = () => {};

  delete require.cache[notificationPath];
  return {
    notification: require(notificationPath),
    calls,
    restore() {
      Module._load = originalLoad;
      fs.existsSync = originalExistsSync;
      fs.readFileSync = originalReadFileSync;
      console.log = originalLog;
      console.warn = originalWarn;
      delete require.cache[notificationPath];
    },
  };
}

async function run() {
  const missing = loadNotification({
    credentialFileExists: false,
    serviceAccount: null,
  });
  assert.strictEqual(missing.notification.ensureFirebaseReady(), false);
  assert.strictEqual(missing.notification.isFirebaseReady(), false);
  assert.strictEqual(missing.calls.initializeApp.length, 0);
  assert.strictEqual(
    missing.notification.getFirebaseDiagnostics().firebaseInitError,
    'firebase.json not found'
  );
  missing.restore();

  const serviceAccount = {
    project_id: 'test-project',
    client_email: 'firebase-test@test-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n',
  };
  const initialized = loadNotification({
    credentialFileExists: true,
    serviceAccount,
  });
  assert.strictEqual(initialized.notification.isFirebaseReady(), true);
  assert.strictEqual(initialized.calls.cert.length, 1);
  assert.deepStrictEqual(initialized.calls.cert[0], serviceAccount);
  assert.strictEqual(initialized.calls.initializeApp.length, 1);

  const sendResult = await initialized.notification.sendNotificationToTokens(
    ['test-token'],
    'Test title',
    'Test body',
    { bookingId: 42 }
  );
  assert.strictEqual(sendResult.sent, true);
  assert.strictEqual(sendResult.successCount, 1);
  assert.strictEqual(initialized.calls.messages.length, 1);
  assert.strictEqual(
    initialized.calls.messages[0].data.bookingId,
    '42',
    'FCM data values must remain strings'
  );
  initialized.restore();

  console.log('Firebase notification initialization tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
