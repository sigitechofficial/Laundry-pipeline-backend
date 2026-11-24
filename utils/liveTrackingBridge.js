'use strict';

/**
 * Cross-project live-tracking relay.
 *
 * While apps move Firebase projects, the driver (writer) and the customer (reader) of one
 * booking can be on different projects: an old driver build publishes to the legacy RTDB
 * while an updated customer app (or the website) reads the primary one, or the reverse.
 * Old builds cannot be told to write anywhere else, so the backend bridges them:
 *
 *  - the session meta (destination, agent, active…) is written by the backend to the RTDB of
 *    every configured project (utils/liveTrackingRtdb.js), so any reader finds it;
 *  - the meta records `publisherProjectId`, the project of the driver app that asked for the
 *    publisher session (GET /agent/live-tracking/:bookingId);
 *  - this module listens (Admin SDK) to `location` and `route` under the booking in the
 *    publisher's RTDB and mirrors every change into the same paths of every other project's
 *    RTDB. Mirrored writes are plain sets of the latest value, so a duplicate relay (another
 *    server instance) is harmless.
 *
 * Bridges start when the publisher session opens, stop when the session closes or is
 * reassigned, and are reconciled from the RTDB meta at boot and periodically
 * (reconcileBridges), so a restart never leaves a running trip unrelayed.
 * With a single configured project there is nothing to bridge and every call is a no-op.
 */

const firebaseProjects = require('./firebaseProjects');

const LIVE_TRACKING_ROOT = 'liveTracking';
const RTDB_TIMEOUT_MS = Math.max(500, Number(process.env.LIVE_TRACKING_RTDB_TIMEOUT_MS) || 5000);

/** RTDB calls to a missing/unreachable instance never settle: bound them. */
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${RTDB_TIMEOUT_MS}ms`)), RTDB_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const RELAYED_CHILDREN = Object.freeze(['location', 'route']);

/** bookingId -> { sourceProjectId, detach } */
const bridges = new Map();

function key(bookingId) {
  return String(bookingId);
}

function otherProjectIds(sourceProjectId) {
  return firebaseProjects
    .readyProjects()
    .map((p) => p.projectId)
    .filter((id) => id !== sourceProjectId);
}

async function relay(bookingId, child, value, targetProjectIds) {
  const path = `${LIVE_TRACKING_ROOT}/${bookingId}/${child}`;
  await Promise.all(
    targetProjectIds.map(async (projectId) => {
      try {
        await withTimeout(firebaseProjects.databaseFor(projectId).ref(path).set(value), `relay to ${projectId}`);
      } catch (err) {
        console.warn(`[liveTrackingBridge] relay ${path} -> ${projectId} failed:`, err.message);
      }
    })
  );
}

function stopBridge(bookingId) {
  const existing = bridges.get(key(bookingId));
  if (!existing) return false;
  bridges.delete(key(bookingId));
  try {
    existing.detach();
  } catch (_) { /* listener already gone */ }
  console.log(`[liveTrackingBridge] stopped booking=${bookingId}`);
  return true;
}

/**
 * Relay `location`/`route` of a booking from the publisher's project to every other project.
 * Idempotent; restarts the bridge when the publisher project changed.
 * @returns {{ active: boolean, sourceProjectId?: string, targets?: string[], reason?: string }}
 */
function ensureBridge(bookingId, sourceProjectId) {
  if (!sourceProjectId || !firebaseProjects.getProject(sourceProjectId)) {
    stopBridge(bookingId);
    return { active: false, reason: 'PUBLISHER_PROJECT_NOT_CONFIGURED' };
  }
  const targets = otherProjectIds(sourceProjectId);
  if (targets.length === 0) {
    stopBridge(bookingId);
    return { active: false, reason: 'SINGLE_PROJECT' };
  }
  const existing = bridges.get(key(bookingId));
  if (existing && existing.sourceProjectId === sourceProjectId) {
    return { active: true, sourceProjectId, targets };
  }
  stopBridge(bookingId);

  const db = firebaseProjects.databaseFor(sourceProjectId);
  const listeners = RELAYED_CHILDREN.map((child) => {
    const ref = db.ref(`${LIVE_TRACKING_ROOT}/${bookingId}/${child}`);
    let first = true;
    const onValue = (snap) => {
      const value = snap.val();
      // The first event is the current state: an empty source (driver not publishing yet)
      // must not wipe what the other projects already show.
      if (first && value == null) {
        first = false;
        return;
      }
      first = false;
      relay(bookingId, child, value, otherProjectIds(sourceProjectId));
    };
    const onError = (err) => {
      console.warn(`[liveTrackingBridge] listen ${child} booking=${bookingId} failed:`, err.message);
    };
    ref.on('value', onValue, onError);
    return () => ref.off('value', onValue);
  });

  bridges.set(key(bookingId), {
    sourceProjectId,
    detach: () => listeners.forEach((off) => off()),
  });
  console.log(
    `[liveTrackingBridge] relaying booking=${bookingId} from ${sourceProjectId} to ${targets.join(',')}`
  );
  return { active: true, sourceProjectId, targets };
}

/**
 * Bring the running bridges in line with the sessions in RTDB: every active session with a
 * publisher on a configured project is relayed, everything else is stopped.
 * Reads the session list from the primary project (meta is written to every project).
 */
async function reconcileBridges() {
  const projects = firebaseProjects.readyProjects();
  if (projects.length < 2) {
    for (const id of [...bridges.keys()]) stopBridge(id);
    return { ok: true, active: 0, reason: 'SINGLE_PROJECT' };
  }
  const snap = await withTimeout(
    firebaseProjects.databaseFor(projects[0].projectId).ref(LIVE_TRACKING_ROOT).once('value'),
    `reconcile read ${projects[0].projectId}`
  );
  const wanted = new Map();
  snap.forEach((child) => {
    const meta = child.child('meta').val() || {};
    if (meta.active === true && meta.publisherProjectId) {
      wanted.set(child.key, meta.publisherProjectId);
    }
  });
  for (const id of [...bridges.keys()]) {
    if (!wanted.has(id)) stopBridge(id);
  }
  for (const [id, source] of wanted) {
    ensureBridge(id, source);
  }
  return { ok: true, active: bridges.size };
}

function activeBridges() {
  return [...bridges.entries()].map(([bookingId, b]) => ({ bookingId, sourceProjectId: b.sourceProjectId }));
}

module.exports = {
  RELAYED_CHILDREN,
  ensureBridge,
  stopBridge,
  reconcileBridges,
  activeBridges,
};
