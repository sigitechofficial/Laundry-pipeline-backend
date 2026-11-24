/**
 * Firebase Realtime Database live agent tracking sessions.
 * MySQL remains source of truth for booking status; RTDB is the high-frequency GPS channel.
 *
 * The backend may hold more than one Firebase project (utils/firebaseProjects.js) while apps
 * move projects. Session meta is written to the RTDB of every configured project, so a reader
 * on any of them finds it; the driver's GPS is relayed from the publisher's project to the
 * others by utils/liveTrackingBridge.js (meta.publisherProjectId names the publisher).
 */

const { addressDb, users, booking } = require('../models');
const firebaseProjects = require('./firebaseProjects');
const liveTrackingBridge = require('./liveTrackingBridge');

const LIVE_TRACKING_ROOT = 'liveTracking';
/** Awaiting collection — demo / pre-trip pickup (one step before “I’m on the way”). */
const PRE_TRIP_STATUS_PICKUP = 3;
const ACTIVE_STATUS_PICKUP = 4;
/** Facility done — demo / pre-trip delivery (one step before Out for Delivery). */
const PRE_TRIP_STATUS_DELIVERY = 12;
const ACTIVE_STATUS_DELIVERY = 13;
const CLOSE_STATUSES = new Set([5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 21, 22, 24]);

function isPickupTrackableStatus(statusId) {
  const id = Number(statusId);
  return id === PRE_TRIP_STATUS_PICKUP || id === ACTIVE_STATUS_PICKUP;
}

function isDeliveryTrackableStatus(statusId) {
  const id = Number(statusId);
  return id === PRE_TRIP_STATUS_DELIVERY || id === ACTIVE_STATUS_DELIVERY;
}

function isLiveTrackableStatus(statusId) {
  return isPickupTrackableStatus(statusId) || isDeliveryTrackableStatus(statusId);
}

function legForStatus(statusId) {
  return isDeliveryTrackableStatus(statusId) ? 'delivery' : 'pickup';
}

/** RTDB handle of one project, or null when it is not configured / not reachable. */
function getDb(projectId) {
  if (!projectId) return null;
  try {
    return firebaseProjects.databaseFor(projectId);
  } catch (err) {
    console.warn(`[liveTracking] database for ${projectId} unavailable:`, err.message);
    return null;
  }
}

/** Every configured project's RTDB, primary first: [{ projectId, db }]. */
function trackingDbs() {
  return firebaseProjects
    .readyProjects()
    .map((p) => ({ projectId: p.projectId, db: getDb(p.projectId) }))
    .filter((x) => x.db);
}

function trackingRefIn(db, bookingId) {
  return db.ref(`${LIVE_TRACKING_ROOT}/${bookingId}`);
}

/** Run `fn(ref, projectId)` on the booking in every project; collect per-project results. */
async function forEachProject(bookingId, fn) {
  const results = [];
  for (const { projectId, db } of trackingDbs()) {
    try {
      results.push({ projectId, ok: true, value: await fn(trackingRefIn(db, bookingId), projectId) });
    } catch (err) {
      console.warn(`[liveTracking] booking=${bookingId} project=${projectId}:`, err.message);
      results.push({ projectId, ok: false, error: err.message });
    }
  }
  return results;
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `***${digits.slice(-4)}`;
}

function formatAddressLabel(addr) {
  if (!addr) return null;
  const parts = [
    addr.streetAddress,
    addr.district,
    addr.province,
    addr.postalcode,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function loadDestination(bookingRow, leg) {
  const addressId =
    leg === 'delivery'
      ? bookingRow.dropOffAddressId
      : bookingRow.pickupAddresId || bookingRow.pickupAddressId;

  if (!addressId) {
    return { lat: null, lng: null, addressLabel: null };
  }

  const addressRow = await addressDb.findOne({
    where: { id: addressId },
  });

  if (!addressRow) {
    return { lat: null, lng: null, addressLabel: null };
  }

  const lat = parseFloat(addressRow.lat);
  const lng = parseFloat(addressRow.lng);

  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    addressLabel: formatAddressLabel(addressRow),
  };
}

async function loadAgentDisplay(agentId) {
  if (!agentId) return { name: null, phoneMasked: null };
  const agent = await users.findByPk(agentId, {
    attributes: ['id', 'firstName', 'lastName', 'phoneNum', 'countryCode'],
  });
  if (!agent) return { name: null, phoneMasked: null };
  const name = [agent.firstName, agent.lastName].filter(Boolean).join(' ').trim() || null;
  return {
    name,
    phoneMasked: maskPhone(agent.phoneNum),
  };
}

/**
 * Open or refresh an active live-tracking session for pickup (3/4) or delivery (12/13), in
 * the RTDB of every configured project.
 * `publisherProjectId`: the Firebase project of the driver app asking to publish (agent
 * session request). Omitted (status-driven opens, customer requests) keeps the publisher an
 * active session already has for the same driver.
 */
async function openLiveTrackingSession({
  bookingId,
  leg,
  agentId,
  customerId,
  bookingRow = null,
  publisherProjectId = null,
}) {
  if (trackingDbs().length === 0) {
    return { ok: false, reason: 'RTDB_UNAVAILABLE' };
  }

  const normalizedLeg = leg === 'delivery' ? 'delivery' : 'pickup';
  let row = bookingRow;
  if (!row) {
    row = await booking.findByPk(bookingId, {
      attributes: [
        'id',
        'customerId',
        'driverId',
        'deliveryDriverId',
        'pickupAddresId',
        'dropOffAddressId',
        'bookingStatusId',
      ],
    });
  }
  if (!row) {
    return { ok: false, reason: 'BOOKING_NOT_FOUND' };
  }

  const resolvedAgentId = Number(
    agentId ||
      (normalizedLeg === 'delivery'
        ? row.deliveryDriverId || row.driverId
        : row.driverId) ||
      0
  );
  const resolvedCustomerId = Number(customerId || row.customerId || 0);

  if (!resolvedAgentId || !resolvedCustomerId) {
    console.warn(
      `[liveTracking] refuse open booking=${bookingId} agent=${resolvedAgentId} customer=${resolvedCustomerId}`
    );
    return { ok: false, reason: 'MISSING_PARTIES' };
  }

  const destination = await loadDestination(row, normalizedLeg);
  const agent = await loadAgentDisplay(resolvedAgentId);
  const now = Date.now();

  // Preserve startedAt (and the publisher, for the same driver) when refreshing an
  // already-active session; projects may disagree after a partial failure, so take the
  // earliest start and the first publisher found.
  const previous = await forEachProject(bookingId, async (ref) => (await ref.child('meta').once('value')).val());
  let startedAt = now;
  let keptPublisher = null;
  for (const r of previous) {
    const prev = r.ok ? r.value : null;
    if (!prev || prev.active !== true) continue;
    if (prev.startedAt) startedAt = Math.min(startedAt, Number(prev.startedAt) || now);
    if (!keptPublisher && prev.publisherProjectId && Number(prev.agentId) === resolvedAgentId) {
      keptPublisher = prev.publisherProjectId;
    }
  }

  const meta = {
    agentId: resolvedAgentId,
    customerId: resolvedCustomerId,
    leg: normalizedLeg,
    active: true,
    startedAt,
    endedAt: null,
    closeReason: null,
    publisherProjectId: publisherProjectId || keptPublisher || null,
    destination,
    agent,
  };

  const written = await forEachProject(bookingId, (ref) => ref.child('meta').set(meta));
  const projects = written.filter((r) => r.ok).map((r) => r.projectId);
  if (projects.length === 0) {
    return { ok: false, reason: 'RTDB_WRITE_FAILED', failed: written };
  }

  const bridge = meta.publisherProjectId
    ? liveTrackingBridge.ensureBridge(bookingId, meta.publisherProjectId)
    : { active: false, reason: 'NO_PUBLISHER_YET' };

  console.log(
    `[liveTracking] opened booking=${bookingId} leg=${normalizedLeg} agent=${resolvedAgentId} ` +
      `projects=${projects.join(',')} publisher=${meta.publisherProjectId || '-'}`
  );
  return {
    ok: true,
    meta,
    path: `${LIVE_TRACKING_ROOT}/${bookingId}`,
    projects,
    failedProjects: written.filter((r) => !r.ok).map((r) => r.projectId),
    bridge,
  };
}

/**
 * Close (deactivate) a live-tracking session.
 */
async function closeLiveTrackingSession(bookingId, { reason = 'ended' } = {}) {
  liveTrackingBridge.stopBridge(bookingId);
  if (trackingDbs().length === 0) {
    return { ok: false, reason: 'RTDB_UNAVAILABLE' };
  }

  const now = Date.now();
  const results = await forEachProject(bookingId, async (ref) => {
    const snap = await ref.child('meta').once('value');
    if (!snap.exists()) return false;
    await ref.child('meta').update({
      active: false,
      endedAt: now,
      closeReason: reason,
    });
    return true;
  });
  const closedIn = results.filter((r) => r.ok && r.value).map((r) => r.projectId);
  if (closedIn.length === 0) {
    return { ok: true, skipped: true, reason: 'NO_SESSION' };
  }

  console.log(`[liveTracking] closed booking=${bookingId} reason=${reason} projects=${closedIn.join(',')}`);
  return { ok: true, endedAt: now, projects: closedIn };
}

/**
 * Auto-open session only once the driver is in transit (4 / 13).
 * Status 3 / 12 stay trackable for explicit demo / publisher start, but do not
 * auto-open on every accept / facility-complete. Close for arrived / cancel / hold.
 * Safe to call fire-and-forget (never throws to caller).
 */
async function syncLiveTrackingForBookingStatus(bookingId, bookingStatusId, extras = {}) {
  try {
    const statusId = Number(bookingStatusId);
    if (statusId === ACTIVE_STATUS_PICKUP) {
      return await openLiveTrackingSession({
        bookingId,
        leg: 'pickup',
        agentId: extras.agentId,
        customerId: extras.customerId,
        bookingRow: extras.bookingRow,
      });
    }
    if (statusId === ACTIVE_STATUS_DELIVERY) {
      return await openLiveTrackingSession({
        bookingId,
        leg: 'delivery',
        agentId: extras.agentId,
        customerId: extras.customerId,
        bookingRow: extras.bookingRow,
      });
    }
    if (CLOSE_STATUSES.has(statusId)) {
      return await closeLiveTrackingSession(bookingId, {
        reason: extras.reason || `status_${statusId}`,
      });
    }
    return { ok: true, skipped: true };
  } catch (err) {
    console.error(
      `[liveTracking] sync failed booking=${bookingId} status=${bookingStatusId}:`,
      err.message
    );
    return { ok: false, reason: err.message };
  }
}

/**
 * Update agentId on an active session (reassign mid-trip).
 */
async function reassignLiveTrackingAgent(bookingId, newAgentId) {
  if (trackingDbs().length === 0) return { ok: false, reason: 'RTDB_UNAVAILABLE' };

  const agent = await loadAgentDisplay(newAgentId);
  // The new driver's app names its project when it asks for the publisher session.
  liveTrackingBridge.stopBridge(bookingId);
  const results = await forEachProject(bookingId, async (ref) => {
    const meta = (await ref.child('meta').once('value')).val();
    if (!meta || !meta.active) return false;
    await ref.child('meta').update({
      agentId: Number(newAgentId),
      agent,
      publisherProjectId: null,
    });
    return true;
  });
  if (!results.some((r) => r.ok && r.value)) {
    return { ok: false, reason: 'NO_ACTIVE_SESSION' };
  }
  return { ok: true };
}

/**
 * Delete inactive tracking nodes older than maxAgeMs (default 6h).
 */
async function cleanupStaleLiveTrackingSessions({ maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const dbs = trackingDbs();
  if (dbs.length === 0) return { ok: false, deleted: 0 };
  let deleted = 0;
  for (const { projectId, db } of dbs) {
    try {
      deleted += await cleanupProject(db, maxAgeMs);
    } catch (err) {
      console.warn(`[liveTracking] cleanup project=${projectId} failed:`, err.message);
    }
  }
  console.log(`[liveTracking] cleanup deleted=${deleted}`);
  return { ok: true, deleted };
}

async function cleanupProject(db, maxAgeMs) {
  const root = db.ref(LIVE_TRACKING_ROOT);
  const snap = await root.once('value');
  if (!snap.exists()) return 0;

  const now = Date.now();
  const updates = {};
  let deleted = 0;

  snap.forEach((child) => {
    const meta = child.child('meta').val() || {};
    const endedAt = meta.endedAt ? Number(meta.endedAt) : null;
    const startedAt = meta.startedAt ? Number(meta.startedAt) : null;
    const active = meta.active === true;

    const isStaleInactive =
      !active && endedAt && now - endedAt > maxAgeMs;
    const isOrphanActive =
      active && startedAt && now - startedAt > 24 * 60 * 60 * 1000;

    if (isStaleInactive || isOrphanActive) {
      updates[child.key] = null;
      deleted += 1;
    }
  });

  if (deleted > 0) {
    await root.update(updates);
  }
  return deleted;
}

/**
 * The booking's tracking node as one project's RTDB holds it (the project the asking app
 * reads), or the primary project's when `projectId` is omitted.
 */
async function getLiveTrackingSnapshot(bookingId, projectId = null) {
  const target = projectId || (firebaseProjects.readyProjects()[0] || {}).projectId;
  const db = getDb(target);
  if (!db) return null;
  const snap = await trackingRefIn(db, bookingId).once('value');
  return snap.exists() ? snap.val() : null;
}

module.exports = {
  LIVE_TRACKING_ROOT,
  PRE_TRIP_STATUS_PICKUP,
  PRE_TRIP_STATUS_DELIVERY,
  ACTIVE_STATUS_PICKUP,
  ACTIVE_STATUS_DELIVERY,
  CLOSE_STATUSES,
  isPickupTrackableStatus,
  isDeliveryTrackableStatus,
  isLiveTrackableStatus,
  legForStatus,
  openLiveTrackingSession,
  closeLiveTrackingSession,
  syncLiveTrackingForBookingStatus,
  reassignLiveTrackingAgent,
  cleanupStaleLiveTrackingSessions,
  getLiveTrackingSnapshot,
};
