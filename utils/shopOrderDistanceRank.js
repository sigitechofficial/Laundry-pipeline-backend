'use strict';

/**
 * Rank / sort new-order rows by distance from the agent's shop.
 * Pure helpers — used by fetchVisibleNewBookings and unit tests.
 */

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

/**
 * Km from a shop to an order's pickup and drop-off address. A missing or
 * invalid coordinate gives null for that leg (never throws), so callers can
 * sort/notify with whatever distance is known.
 * @returns {Promise<{ pickupDistanceKm: number|null, deliveryDistanceKm: number|null }>}
 */
async function computeShopOrderDistances(
  shopLat,
  shopLng,
  pickupAddress,
  dropOffAddress
) {
  const getDistance = require('./distanceCalculator');
  // Missing or never-geocoded (0,0) coordinates count as unknown.
  const usable = (lat, lng) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    (Math.abs(lat) > 0.0001 || Math.abs(lng) > 0.0001);
  const sLat = parseFloat(shopLat);
  const sLng = parseFloat(shopLng);
  const km = async (address) => {
    const lat = parseFloat(address?.lat);
    const lng = parseFloat(address?.lng);
    if (!usable(sLat, sLng) || !usable(lat, lng)) return null;
    try {
      return await getDistance(sLat, sLng, lat, lng);
    } catch (_) {
      return null;
    }
  };
  return {
    pickupDistanceKm: await km(pickupAddress),
    deliveryDistanceKm: await km(dropOffAddress),
  };
}

/**
 * Admin "Assign shop" order: the shop that currently holds the order first,
 * then nearest to the pickup (unknown distance last), then the shop where the
 * customer has the most completed orders, then name.
 * Mutates and returns [shops].
 */
function sortAssignableShops(shops) {
  return shops.sort((a, b) => {
    if (Boolean(a.isCurrentShop) !== Boolean(b.isCurrentShop)) {
      return a.isCurrentShop ? -1 : 1;
    }
    const ad = a.distanceKm == null ? Number.POSITIVE_INFINITY : Number(a.distanceKm);
    const bd = b.distanceKm == null ? Number.POSITIVE_INFINITY : Number(b.distanceKm);
    if (ad !== bd) return ad - bd;
    const ac = a.customerOrdersAtShop || 0;
    const bc = b.customerOrdersAtShop || 0;
    if (ac !== bc) return bc - ac;
    return String(a.shopName).localeCompare(String(b.shopName), undefined, {
      sensitivity: 'base',
    });
  });
}

module.exports = {
  sortByPickupThenDelivery,
  applyNearestDistanceRanks,
  computeShopOrderDistances,
  sortAssignableShops,
};
