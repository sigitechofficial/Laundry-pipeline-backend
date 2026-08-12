/**
 * Firebase Realtime Database live agent tracking sessions.
 * MySQL remains source of truth for booking status; RTDB is the high-frequency GPS channel.
 */

const admin = require('firebase-admin');
const { addressDb, users, booking } = require('../models');
const { ensureFirebaseReady, getFirebaseDatabaseUrl } = require('./notification');

const LIVE_TRACKING_ROOT = 'liveTracking';
const ACTIVE_STATUS_PICKUP = 4;
const ACTIVE_STATUS_DELIVERY = 13;
const CLOSE_STATUSES = new Set([3, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 21, 22, 24]);

function getDb() {
  if (!ensureFirebaseReady()) {
    return null;
  }
  const databaseURL = getFirebaseDatabaseUrl();
  if (!databaseURL) {
    console.warn('[liveTracking] FIREBASE_DATABASE_URL not set — skipping RTDB write');
    return null;
  }
  try {
    return admin.database();
  } catch (err) {
    console.warn('[liveTracking] admin.database() failed:', err.message);
    return null;
  }
}

function trackingRef(bookingId) {
  const db = getDb();
  if (!db) return null;
  return db.ref(`${LIVE_TRACKING_ROOT}/${bookingId}`);
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
    attributes: ['id', 'firstName', 'lastName', 'phoneNum'],
  });
  if (!agent) return { name: null, phoneMasked: null };
  const name = [agent.firstName, agent.lastName].filter(Boolean).join(' ').trim() || null;
  return {
    name,
    phoneMasked: maskPhone(agent.phoneNum),
  };
}

/**
 * Open or refresh an active live-tracking session for pickup (4) or delivery (13).
 */
async function openLiveTrackingSession({
  bookingId,
  leg,
  agentId,
  customerId,
  bookingRow = null,
}) {
  const ref = trackingRef(bookingId);
  if (!ref) {
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

  // Preserve startedAt when refreshing an already-active session.
  let startedAt = now;
  try {
    const existingSnap = await ref.child('meta').once('value');
    const prev = existingSnap.val();
    if (prev && prev.active === true && prev.startedAt) {
      startedAt = Number(prev.startedAt) || now;
    }
  } catch (_) { /* ignore */ }

  const meta = {
    agentId: resolvedAgentId,
    customerId: resolvedCustomerId,
    leg: normalizedLeg,
    active: true,
    startedAt,
    endedAt: null,
    closeReason: null,
    destination,
    agent,
  };

  await ref.child('meta').set(meta);

  console.log(
    `[liveTracking] opened booking=${bookingId} leg=${normalizedLeg} agent=${resolvedAgentId}`
  );
  return { ok: true, meta, path: `${LIVE_TRACKING_ROOT}/${bookingId}` };
}

/**
 * Close (deactivate) a live-tracking session.
 */
async function closeLiveTrackingSession(bookingId, { reason = 'ended' } = {}) {
  const ref = trackingRef(bookingId);
  if (!ref) {
    return { ok: false, reason: 'RTDB_UNAVAILABLE' };
  }

  const snap = await ref.child('meta').once('value');
  if (!snap.exists()) {
    return { ok: true, skipped: true, reason: 'NO_SESSION' };
  }

  const now = Date.now();
  await ref.child('meta').update({
    active: false,
    endedAt: now,
    closeReason: reason,
  });

  console.log(`[liveTracking] closed booking=${bookingId} reason=${reason}`);
  return { ok: true, endedAt: now };
}

/**
 * Open session for status 4 / 13; close for arrived / cancel / hold.
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
  const ref = trackingRef(bookingId);
  if (!ref) return { ok: false, reason: 'RTDB_UNAVAILABLE' };

  const snap = await ref.child('meta').once('value');
  const meta = snap.val();
  if (!meta || !meta.active) {
    return { ok: false, reason: 'NO_ACTIVE_SESSION' };
  }

  const agent = await loadAgentDisplay(newAgentId);
  await ref.child('meta').update({
    agentId: Number(newAgentId),
    agent,
  });
  return { ok: true };
}

/**
 * Delete inactive tracking nodes older than maxAgeMs (default 6h).
 */
async function cleanupStaleLiveTrackingSessions({ maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const db = getDb();
  if (!db) return { ok: false, deleted: 0 };

  const root = db.ref(LIVE_TRACKING_ROOT);
  const snap = await root.once('value');
  if (!snap.exists()) return { ok: true, deleted: 0 };

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

  console.log(`[liveTracking] cleanup deleted=${deleted}`);
  return { ok: true, deleted };
}

async function getLiveTrackingSnapshot(bookingId) {
  const ref = trackingRef(bookingId);
  if (!ref) return null;
  const snap = await ref.once('value');
  return snap.exists() ? snap.val() : null;
}

module.exports = {
  LIVE_TRACKING_ROOT,
  ACTIVE_STATUS_PICKUP,
  ACTIVE_STATUS_DELIVERY,
  CLOSE_STATUSES,
  openLiveTrackingSession,
  closeLiveTrackingSession,
  syncLiveTrackingForBookingStatus,
  reassignLiveTrackingAgent,
  cleanupStaleLiveTrackingSessions,
  getLiveTrackingSnapshot,
};
