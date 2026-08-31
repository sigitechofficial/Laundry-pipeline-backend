/**
 * In-process demo GPS stream for liveTracking/{bookingId}.
 * Used by POST /agent/live-tracking/:bookingId/demo-stream
 * (agent app also has an on-device demo for stage without deploy).
 */

'use strict';

const { getDatabase } = require('firebase-admin/database');
const {
  openLiveTrackingSession,
  getLiveTrackingSnapshot,
  isLiveTrackableStatus,
  legForStatus,
} = require('../utils/liveTrackingRtdb');

/** @type {Map<number, { timer: NodeJS.Timeout, stopping: boolean }>} */
const running = new Map();

function headingBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lerp(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

function wobble(point, t, amp = 0.00012) {
  return {
    lat: point.lat + Math.sin(t * Math.PI * 4) * amp,
    lng: point.lng + Math.cos(t * Math.PI * 3) * amp * 0.7,
  };
}

function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let result = '';
  const encodeSigned = (num) => {
    let sgn = num < 0 ? ~(num << 1) : num << 1;
    let out = '';
    while (sgn >= 0x20) {
      out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
      sgn >>= 5;
    }
    out += String.fromCharCode(sgn + 63);
    return out;
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    result += encodeSigned(lat - lastLat);
    result += encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return result;
}

function stopDemoStream(bookingId) {
  const id = Number(bookingId);
  const entry = running.get(id);
  if (!entry) return false;
  entry.stopping = true;
  clearInterval(entry.timer);
  running.delete(id);
  return true;
}

function isDemoStreamRunning(bookingId) {
  return running.has(Number(bookingId));
}

/**
 * Opens (or refreshes) the RTDB session and streams fake coordinates.
 * Returns immediately; stream runs in-process until stop or arrival (if !loop).
 */
async function startDemoStream({
  bookingId,
  bookingRow,
  agentId,
  intervalMs = 2000,
  steps = 40,
  loop = true,
}) {
  const id = Number(bookingId);
  stopDemoStream(id);

  const statusId = Number(bookingRow.bookingStatusId);
  if (!isLiveTrackableStatus(statusId)) {
    const err = new Error(
      'Booking must be status 3/4 (pickup) or 12/13 (delivery) to start demo tracking'
    );
    err.code = 'NOT_IN_TRANSIT';
    throw err;
  }

  const leg = legForStatus(statusId);
  const open = await openLiveTrackingSession({
    bookingId: id,
    leg,
    agentId,
    bookingRow,
  });
  if (!open?.ok) {
    const err = new Error(open?.reason || 'Could not open live tracking session');
    err.code = open?.reason || 'OPEN_FAILED';
    throw err;
  }

  let snapshot = await getLiveTrackingSnapshot(id);
  let dest = {
    lat: Number(snapshot?.meta?.destination?.lat),
    lng: Number(snapshot?.meta?.destination?.lng),
  };
  if (!Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)) {
    dest = { lat: 51.5074, lng: -0.1278 };
  }

  const start = { lat: dest.lat - 0.008, lng: dest.lng - 0.01 };
  const pathPoints = [];
  for (let i = 0; i <= steps; i++) {
    pathPoints.push(lerp(start, dest, i / steps));
  }
  const encoded = encodePolyline(pathPoints);
  const ref = getDatabase().ref(`liveTracking/${id}`);

  let step = 0;
  let stopping = false;
  const tick = async () => {
    if (stopping || !running.has(id)) return;
    const i = step;
    const t = i / steps;
    const raw = pathPoints[i];
    const point = i === 0 || i === steps ? raw : wobble(raw, t);
    const next = pathPoints[Math.min(i + 1, steps)];
    const remaining = distanceMeters(point, dest);
    const etaSeconds = Math.max(30, Math.round(remaining / 8.5));

    try {
      await ref.child('location').set({
        lat: point.lat,
        lng: point.lng,
        heading: headingBetween(point, next),
        speed: 8.5,
        accuracy: 8,
        updatedAt: Date.now(),
      });
      if (i % 5 === 0 || i === steps) {
        await ref.child('route').set({
          encodedPolyline: encoded,
          etaSeconds,
          distanceMeters: Math.round(remaining),
          etaText: `${Math.max(1, Math.round(etaSeconds / 60))} min`,
          distanceText:
            remaining >= 1000
              ? `${(remaining / 1000).toFixed(1)} km`
              : `${Math.round(remaining)} m`,
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      console.error(`[demoStream] write failed booking=${id}`, e.message);
      stopDemoStream(id);
      return;
    }

    if (i >= steps) {
      if (loop) {
        step = 0;
      } else {
        stopDemoStream(id);
      }
    } else {
      step = i + 1;
    }
  };

  await tick();
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);

  running.set(id, {
    timer,
    get stopping() {
      return stopping;
    },
    set stopping(v) {
      stopping = v;
    },
  });

  return {
    bookingId: id,
    started: true,
    loop,
    intervalMs,
    steps,
    destination: dest,
  };
}

module.exports = {
  startDemoStream,
  stopDemoStream,
  isDemoStreamRunning,
};
