'use strict';

/**
 * utils/liveTrackingBridge.js: the driver's location/route is relayed from the publisher's
 * Firebase project RTDB to every other configured project's RTDB.
 */

const assert = require('assert');
const path = require('path');

/** Minimal in-memory RTDB: per project a map path -> value, with value listeners. */
function fakeDb() {
  const data = new Map();
  const listeners = new Map();
  const snap = (key, value) => ({ key, val: () => value, child: (c) => snap(c, value && value[c] !== undefined ? value[c] : null) });
  return {
    data,
    listenerCount: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
    ref(p) {
      return {
        async set(value) {
          data.set(p, value);
          (listeners.get(p) || []).forEach((cb) => cb(snap(p, value)));
        },
        on(event, cb) {
          if (!listeners.has(p)) listeners.set(p, []);
          listeners.get(p).push(cb);
          cb(snap(p, data.has(p) ? data.get(p) : null));
        },
        off(event, cb) {
          listeners.set(p, (listeners.get(p) || []).filter((x) => x !== cb));
        },
        async once() {
          if (p === 'liveTracking') throw new Error('reconcile must not download the whole liveTracking tree');
          return snap(p, data.has(p) ? data.get(p) : null);
        },
      };
    },
  };
}

const dbs = { 'new-project': fakeDb(), 'old-project': fakeDb() };
let ready = ['new-project', 'old-project'];
const unreadable = new Set();
const project = (projectId) => ({
  projectId,
  databaseURL: `https://${projectId}.rtdb.test`,
  app: { options: { credential: { getAccessToken: async () => ({ access_token: 't', expires_in: 3600 }) } } },
});
// REST shallow listing (rtdbAccess.childKeys): keys under liveTracking in the fake project.
global.fetch = async (url) => {
  const u = new URL(url);
  const projectId = u.hostname.replace('.rtdb.test', '');
  assert.strictEqual(u.pathname, '/liveTracking.json');
  assert.strictEqual(u.searchParams.get('shallow'), 'true');
  if (unreadable.has(projectId)) return { status: 503, json: async () => ({ error: 'down' }) };
  const keys = {};
  for (const k of dbs[projectId].data.keys()) {
    const m = /^liveTracking\/([^/]+)\//.exec(k);
    if (m) keys[m[1]] = true;
  }
  return { status: 200, json: async () => (Object.keys(keys).length ? keys : null) };
};
const projectsPath = require.resolve(path.join(__dirname, '..', 'utils', 'firebaseProjects'));
require.cache[projectsPath] = {
  id: projectsPath,
  filename: projectsPath,
  loaded: true,
  exports: {
    readyProjects: () => ready.map(project),
    getProject: (id) => (ready.includes(id) ? project(id) : null),
    databaseFor: (id) => dbs[id],
  },
};

const originalLog = console.log;
console.log = () => {};
console.warn = () => {};
const rtdbAccess = require('../utils/rtdbAccess');
const bridge = require('../utils/liveTrackingBridge');
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const OLD = dbs['old-project'];
  const NEW = dbs['new-project'];

  // An old driver build publishes to the legacy RTDB; the new customer app reads the primary.
  await OLD.ref('liveTracking/5/location').set({ lat: 1, lng: 2, updatedAt: 1 });
  let r = bridge.ensureBridge(5, 'old-project');
  assert.deepStrictEqual(r, { active: true, sourceProjectId: 'old-project', targets: ['new-project'] });
  await tick();
  assert.deepStrictEqual(NEW.data.get('liveTracking/5/location'), { lat: 1, lng: 2, updatedAt: 1 }, 'current position relayed at once');

  await OLD.ref('liveTracking/5/location').set({ lat: 3, lng: 4, updatedAt: 2 });
  await OLD.ref('liveTracking/5/route').set({ encodedPolyline: 'abc', updatedAt: 2 });
  await tick();
  assert.deepStrictEqual(NEW.data.get('liveTracking/5/location'), { lat: 3, lng: 4, updatedAt: 2 });
  assert.deepStrictEqual(NEW.data.get('liveTracking/5/route'), { encodedPolyline: 'abc', updatedAt: 2 });

  // Idempotent; no relay back into the source.
  bridge.ensureBridge(5, 'old-project');
  assert.strictEqual(OLD.listenerCount(), 2);
  assert.strictEqual(NEW.listenerCount(), 0);

  // A source with nothing yet does not wipe what readers already show.
  await NEW.ref('liveTracking/6/location').set({ lat: 9, lng: 9, updatedAt: 1 });
  bridge.ensureBridge(6, 'old-project');
  await tick();
  assert.deepStrictEqual(NEW.data.get('liveTracking/6/location'), { lat: 9, lng: 9, updatedAt: 1 });

  // Publisher moves to the new project (driver updated the app): bridge flips direction.
  bridge.ensureBridge(5, 'new-project');
  assert.strictEqual(OLD.listenerCount(), 2, 'only booking 6 still listens on old');
  await NEW.ref('liveTracking/5/location').set({ lat: 5, lng: 6, updatedAt: 3 });
  await tick();
  assert.deepStrictEqual(OLD.data.get('liveTracking/5/location'), { lat: 5, lng: 6, updatedAt: 3 });

  // Stop detaches.
  assert.strictEqual(bridge.stopBridge(5), true);
  assert.strictEqual(bridge.stopBridge(5), false);
  assert.strictEqual(NEW.listenerCount(), 0);

  // Reconcile from RTDB meta (primary): active sessions with a publisher are relayed, others stopped.
  await NEW.ref('liveTracking/7/meta').set({ active: true, publisherProjectId: 'old-project' });
  await NEW.ref('liveTracking/8/meta').set({ active: false, publisherProjectId: 'old-project' });
  let rec = await bridge.reconcileBridges();
  assert.strictEqual(rec.active, 1);
  assert.deepStrictEqual(bridge.activeBridges(), [{ bookingId: '7', sourceProjectId: 'old-project' }]);

  // Union over projects: a session whose meta write only reached the legacy RTDB stays relayed.
  await OLD.ref('liveTracking/10/meta').set({ active: true, startedAt: 100, publisherProjectId: 'old-project' });
  // Projects disagree: the most recent meta wins (closed later in the legacy RTDB).
  await NEW.ref('liveTracking/11/meta').set({ active: true, startedAt: 100, publisherProjectId: 'old-project' });
  await OLD.ref('liveTracking/11/meta').set({ active: false, startedAt: 100, endedAt: 200, publisherProjectId: 'old-project' });
  rec = await bridge.reconcileBridges();
  assert.deepStrictEqual(bridge.activeBridges().map((b) => b.bookingId).sort(), ['10', '7']);

  // One project unreadable: the other's metas still drive reconcile.
  unreadable.add('new-project');
  rec = await bridge.reconcileBridges();
  assert.deepStrictEqual(rec.unreadable, ['new-project']);
  assert.deepStrictEqual(bridge.activeBridges().map((b) => b.bookingId).sort(), ['10', '7']);
  // No project readable: running bridges are left alone.
  unreadable.add('old-project');
  await assert.rejects(() => bridge.reconcileBridges(), /no project readable/);
  assert.strictEqual(bridge.activeBridges().length, 2);
  unreadable.clear();
  rtdbAccess.resetForTests();
  bridge.stopBridge(10);

  // Unknown publisher project, and single-project servers: nothing to bridge.
  assert.strictEqual(bridge.ensureBridge(9, 'third-project').active, false);
  ready = ['new-project'];
  assert.deepStrictEqual(bridge.ensureBridge(9, 'new-project'), { active: false, reason: 'SINGLE_PROJECT' });
  await bridge.reconcileBridges();
  assert.deepStrictEqual(bridge.activeBridges(), []);

  console.log = originalLog;
  console.log('liveTrackingBridge.test.js: all assertions passed');
})().catch((err) => {
  console.log = originalLog;
  console.error(err);
  process.exit(1);
});
