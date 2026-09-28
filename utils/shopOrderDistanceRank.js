'use strict';

/**
 * Rank / sort new-order rows by distance from the agent's shop.
 * Pure helpers — used by fetchVisibleNewBookings and unit tests.
 */

const getdistance = require('./distanceCalculator');

function toCoord(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * km from a shop to an order's pickup / delivery address. Null when either
 * side has no usable coordinates (0,0 means the shop was never geocoded).
 */
async function computeShopOrderDistances(shopLat, shopLng, pickupAddress, dropOffAddress) {
  const sLat = toCoord(shopLat);
  const sLng = toCoord(shopLng);
  const result = { pickupDistanceKm: null, deliveryDistanceKm: null };
  if (sLat == null || sLng == null) return result;
  if (Math.abs(sLat) < 0.0001 && Math.abs(sLng) < 0.0001) return result;

  const legs = [
    ['pickupDistanceKm', pickupAddress],
    ['deliveryDistanceKm', dropOffAddress],
  ];
  for (const [key, address] of legs) {
    const lat = toCoord(address?.lat);
    const lng = toCoord(address?.lng);
    if (lat == null || lng == null) continue;
    result[key] = await getdistance(sLat, sLng, lat, lng);
  }
  return result;
}

function sortByPickupThenDelivery(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  return [...rows].sort((a, b) => {
    const ap = a.pickupDistanceKm;
    const bp = b.pickupDistanceKm;
    const aPickup = ap == null ? Number.POSITIVE_INFINITY : Number(ap);
    const bPickup = bp == null ? Number.POSITIVE_INFINITY : Number(bp);
    if (aPickup !== bPickup) return aPickup - bPickup;
    const ad = a.deliveryDistanceKm;
    const bd = b.deliveryDistanceKm;
    const aDel = ad == null ? Number.POSITIVE_INFINITY : Number(ad);
    const bDel = bd == null ? Number.POSITIVE_INFINITY : Number(bd);
    if (aDel !== bDel) return aDel - bDel;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

/**
 * Mutates rows: sorts nearest-pickup-first and sets top-3 rank badges.
 * @returns {object[]} sorted rows (same references)
 */
function applyNearestDistanceRanks(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  for (const row of rows) {
    row.isNearestPickup = false;
    row.isNearestDelivery = false;
    row.nearestPickupRank = null;
    row.nearestDeliveryRank = null;
  }

  const sorted = sortByPickupThenDelivery(rows);
  // Keep caller array order in sync with sorted order.
  rows.length = 0;
  rows.push(...sorted);

  let pickupRank = 0;
  for (const row of rows) {
    if (row.pickupDistanceKm == null) continue;
    pickupRank += 1;
    row.nearestPickupRank = pickupRank;
    row.isNearestPickup = pickupRank === 1;
    if (pickupRank >= 3) break;
  }

  const byDelivery = [...rows]
    .filter((r) => r.deliveryDistanceKm != null)
    .sort(
      (a, b) => Number(a.deliveryDistanceKm) - Number(b.deliveryDistanceKm)
    );
  byDelivery.slice(0, 3).forEach((row, idx) => {
    row.nearestDeliveryRank = idx + 1;
    row.isNearestDelivery = idx === 0;
  });

  return rows;
}

module.exports = {
  computeShopOrderDistances,
  sortByPickupThenDelivery,
  applyNearestDistanceRanks,
};
