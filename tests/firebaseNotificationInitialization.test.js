'use strict';

/**
 * utils/firebaseProjects.js + utils/notification.js with a fake Firebase Admin SDK:
 * credential sources (./firebase.json fallback, FIREBASE_CREDENTIALS_PATH, optional legacy),
 * per-project apps, client project resolution, diagnostics, and routed sends that record
 * each token's project and delete only tokens no project accepts.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CRED = path.join(ROOT, 'firebase.json');
const ENV_KEYS = [
  'FIREBASE_CREDENTIALS_PATH',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_LEGACY_CREDENTIALS_PATH',
  'FIREBASE_LEGACY_DATABASE_URL',
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-projects-test-'));
function saFile(name, projectId) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify({
    project_id: projectId,
    client_email: `sdk@${projectId}.iam.gserviceaccount.com`,
    private_key: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n',
  }));
  return p;
}
const NEW_CRED = saFile('new.json', 'new-project');
const OLD_CRED = saFile('old.json', 'old-project');
fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json');

/** token -> issuing project, for the fake FCM. */
const TOKEN_OWNER = {};
const deviceRows = [];

function load({ env = {}, defaultCredExists = false } = {}) {
  const apps = [];
  const calls = { initializeApp: [], sends: [] };
  const savedEnv = {};
  // Empty (not deleted): dotenv must not fill them from a developer's .env.
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; process.env[k] = ''; }
  Object.assign(process.env, env);

  const originalLoad = Module._load;
  const originalExists = fs.existsSync;
  const originalRead = fs.readFileSync;
  const originalLog = console.log;
  const originalWarn = console.warn;

  Module._load = function load(request, parent, isMain) {
    if (request === 'firebase-admin/app') {
      return {
        cert: (sa) => ({ sa }),
        getApps: () => apps,
        initializeApp(options, name) {
          calls.initializeApp.push({ options, name });
          const app = { name, options };
          apps.push(app);
          return app;
        },
      };
    }
    if (request === 'firebase-admin/messaging') {
      return {
        getMessaging: (app) => ({
          async sendEachForMulticast(message, dryRun) {
            const projectId = app.options.projectId;
            calls.sends.push({ projectId, tokens: message.tokens, dryRun, data: message.data });
            return {
              responses: message.tokens.map((t) => {
                const owner = TOKEN_OWNER[t];
                if (owner === projectId) return { success: true, messageId: `${projectId}/${t}` };
                if (owner === 'dead') return { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'not found' } };
                return { success: false, error: { code: 'messaging/mismatched-credential', message: 'SenderId mismatch' } };
              }),
            };
          },
        }),
      };
    }
    if (request === '../models' && parent && parent.filename.endsWith(path.join('utils', 'notification.js'))) {
      const matches = (r, where) => Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object') {
          const inList = Object.getOwnPropertySymbols(v).map((s) => v[s])[0];
          return Array.isArray(inList) ? inList.includes(r[k]) : true;
        }
        return r[k] === v;
      });
      return {
        deviceToken: {
          async findAll({ where }) { return deviceRows.filter((r) => matches(r, where)); },
          async update(values, { where }) { deviceRows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, values)); },
          async destroy({ where }) {
            for (let i = deviceRows.length - 1; i >= 0; i--) if (matches(deviceRows[i], where)) deviceRows.splice(i, 1);
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  fs.existsSync = (p) => (path.resolve(p) === DEFAULT_CRED ? defaultCredExists : originalExists(p));
  fs.readFileSync = (p, ...args) =>
    path.resolve(String(p)) === DEFAULT_CRED ? originalRead(OLD_CRED, ...args) : originalRead(p, ...args);
  console.log = () => {};
  console.warn = () => {};

  for (const m of ['../utils/firebaseProjects', '../utils/notification', '../utils/fcmRouting']) {
    delete require.cache[require.resolve(m)];
  }
  return {
    projects: require('../utils/firebaseProjects'),
    notification: require('../utils/notification'),
    calls,
    restore() {
      Module._load = originalLoad;
      fs.existsSync = originalExists;
      fs.readFileSync = originalRead;
      console.log = originalLog;
      console.warn = originalWarn;
      for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    },
  };
}

async function run() {
  // Nothing configured.
  let t = load();
  assert.strictEqual(t.notification.ensureFirebaseReady(), false);
  assert.strictEqual(t.notification.isFirebaseReady(), false);
  assert.strictEqual(t.notification.getFirebaseDiagnostics().firebaseInitError, 'firebase.json not found');
  assert.strictEqual(t.projects.clientProjectFor(null), null);
  assert.strictEqual((await t.notification.sendNotificationToTokens(['x'.repeat(100)], 'T', 'B')).reason, 'FIREBASE_NOT_CONFIGURED');
  t.restore();

  // Servers that only have ./firebase.json keep working: it is the (only) primary project.
  t = load({ defaultCredExists: true });
  assert.deepStrictEqual(t.projects.configuredProjectIds(), ['old-project']);
  assert.strictEqual(t.projects.clientProjectFor(null).projectId, 'old-project');
  assert.strictEqual(t.projects.getProjectByRole('primary').databaseURL, 'https://old-project-default-rtdb.firebaseio.com');
  t.restore();

  // Invalid primary credential is reported, not thrown.
  t = load({ env: { FIREBASE_CREDENTIALS_PATH: path.join(tmp, 'broken.json') } });
  const broken = t.notification.getFirebaseDiagnostics();
  assert.strictEqual(broken.firebaseReady, false);
  assert.strictEqual(broken.parseOk, false);
  t.restore();

  // Primary (new) + legacy (old), each its own named app and RTDB URL.
  t = load({
    env: {
      FIREBASE_CREDENTIALS_PATH: NEW_CRED,
      FIREBASE_DATABASE_URL: 'https://new-project-default-rtdb.europe-west1.firebasedatabase.app',
      FIREBASE_LEGACY_CREDENTIALS_PATH: OLD_CRED,
    },
  });
  assert.strictEqual(t.notification.ensureFirebaseReady(), true);
  assert.deepStrictEqual(t.projects.configuredProjectIds(), ['new-project', 'old-project']);
  assert.deepStrictEqual(t.calls.initializeApp.map((c) => c.name), ['firebase-primary', 'firebase-legacy']);
  assert.deepStrictEqual(t.projects.unclassifiedTokenOrder(), ['old-project', 'new-project']);
  assert.strictEqual(t.projects.clientProjectFor(null).projectId, 'old-project', 'clients that do not say are legacy');
  assert.strictEqual(t.projects.clientProjectFor('new-project').databaseURL, 'https://new-project-default-rtdb.europe-west1.firebasedatabase.app');
  assert.strictEqual(t.projects.clientProjectFor('other-project'), null);
  assert.strictEqual(t.projects.acceptClientProject('new-project'), 'new-project');
  assert.strictEqual(t.projects.acceptClientProject(null), null);
  assert.throws(() => t.projects.acceptClientProject('other-project'), (e) => e.code === 'FIREBASE_PROJECT_NOT_CONFIGURED');
  assert.throws(() => t.projects.messagingFor('other-project'), (e) => e.code === 'FIREBASE_PROJECT_NOT_CONFIGURED');
  const diag = t.notification.getFirebaseDiagnostics();
  assert.deepStrictEqual(diag.projects.map((p) => [p.role, p.projectId, p.ready]), [['primary', 'new-project', true], ['legacy', 'old-project', true]]);
  assert.ok(!JSON.stringify(diag).includes('PRIVATE KEY'), 'diagnostics never expose key material');
  t.ensureAgain = t.notification.ensureFirebaseReady();
  assert.strictEqual(t.calls.initializeApp.length, 2, 'ready projects are not re-initialised');

  // Raw-token send (debug/admin fallback): routed legacy-first, dryRun passed through.
  const APP = 'a'.repeat(100);
  const WEB = 'w'.repeat(100);
  const DEAD = 'd'.repeat(100);
  const FOREIGN = 'f'.repeat(100);
  Object.assign(TOKEN_OWNER, { [APP]: 'old-project', [WEB]: 'new-project', [DEAD]: 'dead', [FOREIGN]: 'third-project' });
  const raw = await t.notification.sendNotificationToTokens([APP, WEB], 'T', 'B', { bookingId: 42 }, { dryRun: true });
  assert.strictEqual(raw.sent, true);
  assert.strictEqual(raw.successCount, 2);
  assert.deepStrictEqual(raw.deliveredByProject, { 'old-project': 1, 'new-project': 1 });
  assert.ok(t.calls.sends.every((s) => s.dryRun === true));
  assert.strictEqual(t.calls.sends[0].data.bookingId, '42', 'FCM data values must remain strings');

  // User send: rows learn their project; a dead token is deleted; a foreign one is kept.
  deviceRows.push(
    { userId: 7, tokenId: APP, firebaseProjectId: null, status: true },
    { userId: 7, tokenId: WEB, firebaseProjectId: null, status: true },
    { userId: 7, tokenId: DEAD, firebaseProjectId: null, status: true },
    { userId: 7, tokenId: FOREIGN, firebaseProjectId: null, status: true },
    { userId: 7, tokenId: 'no-fcm-token', firebaseProjectId: null, status: true },
  );
  t.calls.sends.length = 0;
  const res = await t.notification.sendNotification(7, 'T', 'B', {});
  assert.strictEqual(res.sent, true);
  assert.strictEqual(res.successCount, 2);
  assert.strictEqual(res.reclassifiedTokens, 2);
  assert.strictEqual(res.removedTokens, 1);
  const byToken = Object.fromEntries(deviceRows.map((r) => [r.tokenId, r.firebaseProjectId]));
  assert.deepStrictEqual(byToken, { [APP]: 'old-project', [WEB]: 'new-project', [FOREIGN]: null });

  // Second send: recorded rows go straight to their project (no legacy detour for WEB).
  t.calls.sends.length = 0;
  await t.notification.sendNotification(7, 'T', 'B', {});
  const newSend = t.calls.sends.find((s) => s.projectId === 'new-project' && s.tokens.includes(WEB));
  const oldSendWithWeb = t.calls.sends.find((s) => s.projectId === 'old-project' && s.tokens.includes(WEB));
  assert.ok(newSend && !oldSendWithWeb);
  t.restore();

  // A legacy credential for the same project as the primary is ignored.
  t = load({ env: { FIREBASE_CREDENTIALS_PATH: NEW_CRED, FIREBASE_LEGACY_CREDENTIALS_PATH: NEW_CRED } });
  assert.deepStrictEqual(t.projects.configuredProjectIds(), ['new-project']);
  assert.strictEqual(t.projects.clientProjectFor(null).projectId, 'new-project', 'new-only server: unnamed clients use the primary');
  t.restore();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Firebase notification initialization tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
