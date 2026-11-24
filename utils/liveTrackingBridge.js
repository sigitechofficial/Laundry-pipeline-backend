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
// Bounded + circuit-broken RTDB calls: a dead target project fails fast instead of
// accumulating a pending write per GPS update.
const rtdbAccess = require('./rtdbAccess');

const LIVE_TRACKING_ROOT = 'liveTracking';
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
        await rtdbAccess.guarded(projectId, 'relay to', (db) => db.ref(path).set(value));
      } catch (err) {
        if (err.code === 'RTDB_CIRCUIT_OPEN') return;
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

/** Latest activity of a session meta: a (re)open moves startedAt, a close sets endedAt. */
function metaAge(meta) {
  return Math.max(Number(meta.startedAt) || 0, Number(meta.endedAt) || 0);
}

/**
 * Bring the running bridges in line with the sessions in RTDB: every active session with a
 * publisher on a configured project is relayed, everything else is stopped.
 *
 * The backend writes meta to every project, but a write can fail in one of them (partial
 * failure, a project's RTDB down), so the session list is the union over every project that
 * could be read; where projects disagree about a booking, its most recent meta wins. Only
 * metas are read (never location/route payloads). While a project cannot be read, bridges
 * the readable projects know nothing about are kept; when none can be read, all are kept.
 */
async function reconcileBridges() {
  const projects = firebaseProjects.readyProjects();
  if (projects.length < 2) {
    for (const id of [...bridges.keys()]) stopBridge(id);
    return { ok: true, active: 0, reason: 'SINGLE_PROJECT' };
  }
  const reads = await Promise.all(projects.map(async ({ projectId }) => {
    try {
      return { projectId, ok: true, metas: await rtdbAccess.readChildMetas(projectId, LIVE_TRACKING_ROOT) };
    } catch (err) {
      return { projectId, ok: false, error: err.message };
    }
  }));
  const readable = reads.filter((r) => r.ok);
  if (readable.length === 0) {
    throw new Error(`no project readable (${reads.map((r) => `${r.projectId}: ${r.error}`).join('; ')})`);
  }

  const latest = new Map();
  for (const { metas } of readable) {
    metas.forEach((meta, id) => {
      const prev = latest.get(id);
      if (!prev || metaAge(meta) > metaAge(prev)) latest.set(id, meta);
    });
  }
  const wanted = new Map();
  latest.forEach((meta, id) => {
    if (meta.active === true && meta.publisherProjectId) wanted.set(id, meta.publisherProjectId);
  });

  // With a project unreadable, a running bridge the readable ones know nothing about may
  // still be live there: only stop what a readable project positively shows as not relayable.
  const complete = readable.length === reads.length;
  for (const id of [...bridges.keys()]) {
    if (wanted.has(id)) continue;
    if (complete || latest.has(id)) stopBridge(id);
  }
  for (const [id, source] of wanted) {
    ensureBridge(id, source);
  }
  return {
    ok: true,
    active: bridges.size,
    unreadable: reads.filter((r) => !r.ok).map((r) => r.projectId),
  };
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
