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
          // Root read for reconcile: children of liveTracking.
          const children = [];
          for (const [k, v] of data) {
            const m = /^liveTracking\/([^/]+)\/meta$/.exec(k);
            if (m && p === 'liveTracking') children.push({ key: m[1], meta: v });
          }
          return {
            forEach(fn) { children.forEach((c) => fn({ key: c.key, child: () => ({ val: () => c.meta }) })); },
          };
        },
      };
    },
  };
}

const dbs = { 'new-project': fakeDb(), 'old-project': fakeDb() };
let ready = ['new-project', 'old-project'];
const projectsPath = require.resolve(path.join(__dirname, '..', 'utils', 'firebaseProjects'));
require.cache[projectsPath] = {
  id: projectsPath,
  filename: projectsPath,
  loaded: true,
  exports: {
    readyProjects: () => ready.map((projectId) => ({ projectId })),
    getProject: (id) => (ready.includes(id) ? { projectId: id } : null),
    databaseFor: (id) => dbs[id],
  },
};

const originalLog = console.log;
console.log = () => {};
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
  const rec = await bridge.reconcileBridges();
  assert.strictEqual(rec.active, 1);
  assert.deepStrictEqual(bridge.activeBridges(), [{ bookingId: '7', sourceProjectId: 'old-project' }]);

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
