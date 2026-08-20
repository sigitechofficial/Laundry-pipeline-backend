/**
 * Demo live agent GPS stream → Firebase RTDB.
 * Opens (or refreshes) liveTracking/{bookingId} and writes moving coordinates
 * so the customer Live map can show the agent marker moving.
 *
 * Usage:
 *   node scripts/demoLiveTrackingStream.js --bookingId=123
 *   node scripts/demoLiveTrackingStream.js --bookingId=123 --set-status=4
 *   node scripts/demoLiveTrackingStream.js --bookingId=123 --loop --interval=2000
 *   node scripts/demoLiveTrackingStream.js --bookingId=123 --startLat=51.51 --startLng=-0.14
 *
 * Ctrl+C closes the session (active=false) unless --keep-open.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SA_PATH = path.join(ROOT, 'firebase.json');

function parseArgs(argv) {
  const out = {
    bookingId: null,
    customerId: null,
    agentId: null,
    agentName: 'Demo Driver',
    setStatus: null,
    intervalMs: 2000,
    steps: 40,
    loop: false,
    keepOpen: false,
    startLat: null,
    startLng: null,
    destLat: null,
    destLng: null,
    leg: null,
  };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const k = eq === -1 ? raw.replace(/^--/, '') : raw.slice(2, eq);
    const v = eq === -1 ? undefined : raw.slice(eq + 1);
    if (k === 'bookingId') out.bookingId = Number(v);
    else if (k === 'customerId') out.customerId = Number(v);
    else if (k === 'agentId') out.agentId = Number(v);
    else if (k === 'agentName') out.agentName = v || 'Demo Driver';
    else if (k === 'set-status' || k === 'setStatus') out.setStatus = Number(v);
    else if (k === 'interval') out.intervalMs = Number(v) || 2000;
    else if (k === 'steps') out.steps = Math.max(5, Number(v) || 40);
    else if (k === 'loop') out.loop = v === undefined || v === 'true' || v === '1';
    else if (k === 'keep-open' || k === 'keepOpen') out.keepOpen = true;
    else if (k === 'startLat') out.startLat = Number(v);
    else if (k === 'startLng') out.startLng = Number(v);
    else if (k === 'destLat') out.destLat = Number(v);
    else if (k === 'destLng') out.destLng = Number(v);
    else if (k === 'leg') out.leg = v === 'delivery' ? 'delivery' : 'pickup';
  }
  return out;
}

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

/** Slight side-to-side wobble so the path looks like real road movement. */
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadBooking(bookingId) {
  // Lazy-require models so script can still run with manual coords if DB is down.
  const { booking, addressDb, users } = require('../models');
  const row = await booking.findByPk(bookingId, {
    attributes: [
      'id',
      'customerId',
      'driverId',
      'deliveryDriverId',
      'bookingStatusId',
      'pickupAddresId',
      'dropOffAddressId',
      'orderTrackId',
    ],
  });
  if (!row) throw new Error(`Booking ${bookingId} not found in MySQL`);

  const statusId = Number(row.bookingStatusId);
  const leg =
    statusId === 13 ? 'delivery' : 'pickup';
  const addressId =
    leg === 'delivery' ? row.dropOffAddressId : row.pickupAddresId;
  const addr = addressId
    ? await addressDb.findByPk(addressId)
    : null;
  const destLat = addr ? parseFloat(addr.lat) : null;
  const destLng = addr ? parseFloat(addr.lng) : null;

  const agentId = Number(
    leg === 'delivery'
      ? row.deliveryDriverId || row.driverId
      : row.driverId
  );
  let agentName = 'Demo Driver';
  if (agentId) {
    const agent = await users.findByPk(agentId, {
      attributes: ['firstName', 'lastName'],
    });
    if (agent) {
      agentName =
        [agent.firstName, agent.lastName].filter(Boolean).join(' ') ||
        agentName;
    }
  }

  return {
    bookingId: row.id,
    orderTrackId: row.orderTrackId,
    customerId: Number(row.customerId),
    agentId: agentId || 0,
    agentName,
    bookingStatusId: statusId,
    leg,
    destination: {
      lat: Number.isFinite(destLat) ? destLat : null,
      lng: Number.isFinite(destLng) ? destLng : null,
      addressLabel: addr?.streetAddress || null,
    },
  };
}

async function maybeSetStatus(bookingId, statusId) {
  const { booking, bookingHistory } = require('../models');
  await booking.update({ bookingStatusId: statusId }, { where: { id: bookingId } });
  const now = new Date();
  await bookingHistory.create({
    bookingId,
    bookingStatusId: statusId,
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 8),
  });
  console.log(`[demo] booking ${bookingId} status → ${statusId}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bookingId || !Number.isFinite(args.bookingId)) {
    console.error(
      'Usage: node scripts/demoLiveTrackingStream.js --bookingId=<id> [--set-status=4] [--loop]\n' +
        '   or:  --bookingId=<id> --customerId=<id> --agentId=<id> --destLat=51.5 --destLng=-0.12'
    );
    process.exit(1);
  }

  if (!fs.existsSync(SA_PATH)) {
    throw new Error(`Missing ${SA_PATH}`);
  }
  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    'https://laundry-app-bf43c-default-rtdb.firebaseio.com';

  if (!getApps().length) {
    initializeApp({
      credential: cert(sa),
      databaseURL,
    });
  }

  let metaInfo;
  const hasManualParties =
    Number.isFinite(args.customerId) &&
    args.customerId > 0 &&
    Number.isFinite(args.agentId) &&
    args.agentId > 0;

  if (hasManualParties && Number.isFinite(args.destLat) && Number.isFinite(args.destLng)) {
    metaInfo = {
      bookingId: args.bookingId,
      orderTrackId: String(args.bookingId),
      customerId: args.customerId,
      agentId: args.agentId,
      agentName: args.agentName,
      bookingStatusId: args.setStatus || 4,
      leg: args.leg || (args.setStatus === 13 ? 'delivery' : 'pickup'),
      destination: {
        lat: args.destLat,
        lng: args.destLng,
        addressLabel: 'Demo destination',
      },
    };
    console.log('[demo] Using manual customer/agent/destination (no MySQL)');
  } else {
    try {
      metaInfo = await loadBooking(args.bookingId);
    } catch (err) {
      console.warn(`[demo] MySQL load failed: ${err.message}`);
      if (!hasManualParties) {
        throw new Error(
          'Provide --customerId --agentId --destLat --destLng when MySQL is unavailable'
        );
      }
      metaInfo = {
        bookingId: args.bookingId,
        orderTrackId: String(args.bookingId),
        customerId: args.customerId,
        agentId: args.agentId,
        agentName: args.agentName,
        bookingStatusId: args.setStatus || 4,
        leg: args.leg || 'pickup',
        destination: {
          lat: args.destLat,
          lng: args.destLng,
          addressLabel: 'Demo destination',
        },
      };
    }
  }

  if (args.leg) metaInfo.leg = args.leg;
  if (Number.isFinite(args.destLat) && Number.isFinite(args.destLng)) {
    metaInfo.destination = {
      lat: args.destLat,
      lng: args.destLng,
      addressLabel: metaInfo.destination?.addressLabel || 'Demo destination',
    };
  }

  if (
    !Number.isFinite(metaInfo.destination?.lat) ||
    !Number.isFinite(metaInfo.destination?.lng)
  ) {
    // London default destination if booking address missing
    metaInfo.destination = {
      lat: 51.5074,
      lng: -0.1278,
      addressLabel: 'London demo pin',
    };
    console.warn('[demo] No destination on booking — using London fallback');
  }

  const dest = {
    lat: metaInfo.destination.lat,
    lng: metaInfo.destination.lng,
  };

  // Start ~1.2km SW of destination (or explicit start)
  const start = {
    lat: Number.isFinite(args.startLat)
      ? args.startLat
      : dest.lat - 0.008,
    lng: Number.isFinite(args.startLng)
      ? args.startLng
      : dest.lng - 0.01,
  };

  if (
    metaInfo.bookingStatusId !== 4 &&
    metaInfo.bookingStatusId !== 13 &&
    args.setStatus == null
  ) {
    console.warn(
      `[demo] Booking status is ${metaInfo.bookingStatusId} (need 4 or 13 for customer Live map).`
    );
    console.warn(
      '[demo] Re-run with --set-status=4 (pickup) or --set-status=13 (delivery).'
    );
  }

  if (args.setStatus === 4 || args.setStatus === 13) {
    await maybeSetStatus(args.bookingId, args.setStatus);
    metaInfo.bookingStatusId = args.setStatus;
    metaInfo.leg = args.setStatus === 13 ? 'delivery' : 'pickup';
  }

  if (!metaInfo.customerId || !metaInfo.agentId) {
    throw new Error(
      'customerId/agentId missing — assign a driver on the booking or set DEMO_CUSTOMER_ID / DEMO_AGENT_ID'
    );
  }

  const ref = getDatabase().ref(`liveTracking/${args.bookingId}`);
  const now = Date.now();

  await ref.child('meta').set({
    agentId: metaInfo.agentId,
    customerId: metaInfo.customerId,
    leg: metaInfo.leg,
    active: true,
    startedAt: now,
    endedAt: null,
    closeReason: null,
    destination: metaInfo.destination,
    agent: {
      name: metaInfo.agentName,
      phoneMasked: '***0000',
    },
  });

  console.log('[demo] Session opened');
  console.log(
    JSON.stringify(
      {
        bookingId: args.bookingId,
        orderTrackId: metaInfo.orderTrackId,
        status: metaInfo.bookingStatusId,
        leg: metaInfo.leg,
        customerId: metaInfo.customerId,
        agentId: metaInfo.agentId,
        start,
        dest,
        databaseURL,
        intervalMs: args.intervalMs,
        steps: args.steps,
        loop: args.loop,
      },
      null,
      2
    )
  );
  console.log(
    `\nOpen customer app → booking #${metaInfo.orderTrackId || args.bookingId} → Live map\n`
  );

  const pathPoints = [];
  for (let i = 0; i <= args.steps; i++) {
    pathPoints.push(lerp(start, dest, i / args.steps));
  }
  const encoded = encodePolyline(pathPoints);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[demo] stopping…');
    if (!args.keepOpen) {
      await ref.child('meta').update({
        active: false,
        endedAt: Date.now(),
        closeReason: 'demo_stopped',
      });
      console.log('[demo] session closed (active=false)');
    } else {
      console.log('[demo] --keep-open: left session active');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  do {
    for (let i = 0; i <= args.steps; i++) {
      if (stopping) break;
      const t = i / args.steps;
      const raw = pathPoints[i];
      const point = i === 0 || i === args.steps ? raw : wobble(raw, t);
      const next = pathPoints[Math.min(i + 1, args.steps)];
      const heading = headingBetween(point, next);
      const remaining = distanceMeters(point, dest);
      const etaSeconds = Math.max(30, Math.round((remaining / 8.5) /* ~30km/h */));

      await ref.child('location').set({
        lat: point.lat,
        lng: point.lng,
        heading,
        speed: 8.5,
        accuracy: 8,
        updatedAt: Date.now(),
      });

      // Refresh route every ~5 ticks
      if (i % 5 === 0 || i === args.steps) {
        await ref.child('route').set({
          encodedPolyline: encoded,
          etaSeconds,
          distanceMeters: Math.round(remaining),
          etaText: `${Math.max(1, Math.round(etaSeconds / 60))} min`,
          distanceText: remaining >= 1000
            ? `${(remaining / 1000).toFixed(1)} km`
            : `${Math.round(remaining)} m`,
          updatedAt: Date.now(),
        });
      }

      process.stdout.write(
        `\r[demo] step ${i}/${args.steps}  lat=${point.lat.toFixed(5)} lng=${point.lng.toFixed(5)}  eta=${Math.round(etaSeconds / 60)}m   `
      );
      await sleep(args.intervalMs);
    }
    console.log(args.loop ? '\n[demo] loop restart…' : '\n[demo] arrived at destination');
  } while (args.loop && !stopping);

  await shutdown();
}

main().catch((err) => {
  console.error('[demo] FAILED:', err.message || err);
  process.exit(1);
});
