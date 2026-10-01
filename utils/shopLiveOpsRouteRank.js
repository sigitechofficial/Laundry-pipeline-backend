'use strict';

/**
 * Pure shop-nearest route helpers for admin Live Ops (and tests).
 * No DB — same idea as agent `nearest_orders.dart` shop-fallback.
 */

function parseCoord(v) {
  const n = Number.parseFloat(`${v ?? ''}`.trim());
  return Number.isFinite(n) ? n : null;
}

function latLngOf(addr) {
  const lat = parseCoord(addr?.lat);
  const lng = parseCoord(addr?.lng);
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  return { lat, lng };
}

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) *
      Math.cos(toRad(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function rankByNearestRoute(items, origin, coordsOf) {
  if (!origin || !items.length) {
    return items.map((item) => ({ ...item, stopRank: null, legKm: null }));
  }
  const located = [];
  const unlocated = [];
  for (const item of items) {
    const c = coordsOf(item);
    if (!c) unlocated.push(item);
    else located.push({ item, c });
  }

  const remaining = [...located];
  const ordered = [];
  let at = origin;
  while (remaining.length) {
    let bestIdx = 0;
    let bestKm = haversineKm(at, remaining[0].c);
    for (let i = 1; i < remaining.length; i++) {
      const km = haversineKm(at, remaining[i].c);
      if (km < bestKm) {
        bestKm = km;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push({
      ...picked.item,
      stopRank: ordered.length + 1,
      legKm: Math.round(bestKm * 1000) / 1000,
      distanceKm: Math.round(haversineKm(origin, picked.c) * 1000) / 1000,
    });
    at = picked.c;
  }
  return [
    ...ordered,
    ...unlocated.map((item) => ({
      ...item,
      stopRank: null,
      legKm: null,
      distanceKm: null,
    })),
  ];
}

function slotKey(date, timeFrom) {
  const d =
    date != null && String(date).length >= 10
      ? String(date).slice(0, 10)
      : '9999-99-99';
  const h =
    timeFrom != null && String(timeFrom).length >= 2
      ? String(timeFrom).slice(0, 2)
      : '99';
  return `${d} ${h}`;
}

function sortLaneByRoute(orders, origin, mode) {
  const groups = new Map();
  for (const o of orders) {
    const key =
      mode === 'pickup'
        ? slotKey(o.collectionDate, o.collectionTimeFrom)
        : slotKey(o.deliveryDate, o.deliveryTimeFrom);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const keys = [...groups.keys()].sort();
  const out = [];
  let routeOrigin = origin;
  let stopCounter = 0;
  for (const key of keys) {
    const ranked = rankByNearestRoute(groups.get(key), routeOrigin, (o) =>
      mode === 'pickup' ? latLngOf(o.pickupAddress) : latLngOf(o.dropOffAddress)
    );
    for (const row of ranked) {
      if (row.stopRank != null) {
        stopCounter += 1;
        out.push({ ...row, stopRank: stopCounter });
        const c =
          mode === 'pickup'
            ? latLngOf(row.pickupAddress)
            : latLngOf(row.dropOffAddress);
        if (c) routeOrigin = c;
      } else {
        out.push(row);
      }
    }
  }
  return out;
}

module.exports = {
  parseCoord,
  latLngOf,
  haversineKm,
  rankByNearestRoute,
  slotKey,
  sortLaneByRoute,
};
