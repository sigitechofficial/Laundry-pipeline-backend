'use strict';

/**
 * utils/rtdbAccess.js: per-project RTDB calls are bounded, a failing project's circuit opens
 * so later calls fail fast instead of each waiting out the timeout, a success closes it, and
 * the health probe classifies a missing instance.
 */

process.env.LIVE_TRACKING_RTDB_TIMEOUT_MS = '500';
process.env.LIVE_TRACKING_RTDB_COOLDOWN_MS = '1000';
process.env.LIVE_TRACKING_RTDB_BREAKER_THRESHOLD = '2';

const assert = require('assert');
const path = require('path');

const project = (projectId) => ({
  projectId,
  databaseURL: `https://${projectId}.rtdb.test/`,
  app: { options: { credential: { getAccessToken: async () => ({ access_token: 'tok', expires_in: 3600 }) } } },
});
const projectsPath = require.resolve(path.join(__dirname, '..', 'utils', 'firebaseProjects'));
require.cache[projectsPath] = {
  id: projectsPath,
  filename: projectsPath,
  loaded: true,
  exports: {
    readyProjects: () => ['up', 'down'].map(project),
    getProject: (id) => (['up', 'down', 'missing'].includes(id) ? project(id) : null),
    databaseFor: (id) => ({ id }),
  },
};

const fetched = [];
global.fetch = async (url, opts) => {
  fetched.push({ url, auth: opts.headers.Authorization });
  const host = new URL(url).hostname;
  if (host.startsWith('missing')) return { status: 404, json: async () => null };
  if (host.startsWith('down')) throw new Error('connect ETIMEDOUT');
  return { status: 200, json: async () => ({ liveTracking: true }) };
};

const originalWarn = console.warn;
const originalLog = console.log;
console.warn = () => {};
console.log = () => {};
const rtdb = require('../utils/rtdbAccess');
const never = () => new Promise(() => {});

(async () => {
  // Bounded: a call that never settles fails after the timeout.
  let t0 = Date.now();
  await assert.rejects(() => rtdb.guarded('down', 'RTDB', never), /timed out after 500ms/);
  assert.ok(Date.now() - t0 < 1500);
  assert.strictEqual(rtdb.isOpen('down'), false, 'one failure does not open the circuit');

  await assert.rejects(() => rtdb.guarded('down', 'RTDB', never), /timed out/);
  assert.strictEqual(rtdb.isOpen('down'), true, 'threshold reached: circuit open');
  assert.deepStrictEqual(rtdb.usableProjects().map((p) => p.projectId), ['up']);

  // Open: fails fast without calling the database.
  let called = false;
  t0 = Date.now();
  await assert.rejects(
    () => rtdb.guarded('down', 'RTDB', () => { called = true; return 1; }),
    (err) => err.code === 'RTDB_CIRCUIT_OPEN'
  );
  assert.strictEqual(called, false);
  assert.ok(Date.now() - t0 < 50, 'no timeout paid while open');

  // Other projects are unaffected.
  assert.strictEqual(await rtdb.guarded('up', 'RTDB', async (db) => db.id), 'up');

  // Half-open after the cooldown; a success closes the circuit.
  await new Promise((r) => setTimeout(r, 1050));
  assert.strictEqual(await rtdb.guarded('down', 'RTDB', async () => 'back'), 'back');
  assert.strictEqual(rtdb.isOpen('down'), false);
  assert.strictEqual(rtdb.breakerState('down').failures, 0);

  // Probe: authenticated shallow REST read of the root.
  const ok = await rtdb.probe('up');
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(fetched[0].url, 'https://up.rtdb.test/.json?shallow=true');
  assert.strictEqual(fetched[0].auth, 'Bearer tok');
  const missing = await rtdb.probe('missing');
  assert.strictEqual(missing.status, 'missing');
  assert.strictEqual(missing.httpStatus, 404);
  const down = await rtdb.probe('down');
  assert.strictEqual(down.status, 'unreachable');
  await rtdb.probe('down');
  assert.strictEqual(rtdb.isOpen('down'), true, 'failed probes feed the breaker');
  await rtdb.probe('up');
  assert.strictEqual(rtdb.isOpen('up'), false);

  // Shallow key listing.
  assert.deepStrictEqual(await rtdb.childKeys('up', 'liveTracking'), ['liveTracking']);
  assert.strictEqual(fetched[fetched.length - 1].url, 'https://up.rtdb.test/liveTracking.json?shallow=true');

  console.warn = originalWarn;
  console.log = originalLog;
  console.log('rtdbAccess.test.js: all assertions passed');
})().catch((err) => {
  console.warn = originalWarn;
  console.log = originalLog;
  console.error(err);
  process.exit(1);
});
