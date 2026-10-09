'use strict';

/**
 * Rank / sort new-order rows by distance from the agent's shop.
 * Pure helpers — used by fetchVisibleNewBookings, the new-order broadcast and unit tests.
 */

const legKm = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Km the shop drives for an order: shop → pickup + shop → drop-off (a missing
 * drop-off distance counts as the pickup one; an unknown pickup sorts last).
 */
function tripKm(row) {
  const pickup = legKm(row?.pickupDistanceKm);
  if (pickup == null) return Number.POSITIVE_INFINITY;
  const delivery = legKm(row?.deliveryDistanceKm);
  return pickup + (delivery == null ? pickup : delivery);
}

/** "YYYY-MM-DD HH:MM:SS" of the pickup slot start, for "sooner first" ties. */
function pickupSlotKey(row) {
  const { toDateOnly, toTimeOnly } = require('./shopSlotAvailability');
  return `${toDateOnly(row?.collectionDate) || '9999-12-31'} ${toTimeOnly(row?.collectionTimeFrom) || '99:99:99'}`;
}

/**
 * Nearest job first: least total trip (pickup + delivery km); then the nearer
 * pickup; then the sooner pickup slot; then the newest order.
 */
function compareNearestTrip(a, b) {
  const ta = tripKm(a);
  const tb = tripKm(b);
  if (ta !== tb) return ta - tb;
  const pa = legKm(a?.pickupDistanceKm) ?? Number.POSITIVE_INFINITY;
  const pb = legKm(b?.pickupDistanceKm) ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const sa = pickupSlotKey(a);
  const sb = pickupSlotKey(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return Number(b?.id || 0) - Number(a?.id || 0);
}

/** Always a NEW array (callers clear and refill the original in place). */
function sortNearestTrip(rows) {
  if (!Array.isArray(rows)) return [];
  return [...rows].sort(compareNearestTrip);
}

/** Top-3 badges for one leg (1 = nearest), independent of list order. */
function rankLeg(rows, field, rankField, flagField) {
  rows
    .filter((r) => legKm(r[field]) != null)
    .sort((a, b) => Number(a[field]) - Number(b[field]))
    .slice(0, 3)
    .forEach((row, idx) => {
      row[rankField] = idx + 1;
      row[flagField] = idx === 0;
    });
}

/**
 * Mutates rows: sorts nearest trip first and sets top-3 nearest pickup /
 * nearest delivery badges.
 * @returns {object[]} sorted rows (same references)
 */
function applyNearestDistanceRanks(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  for (const row of rows) {
    row.isNearestPickup = false;
    row.isNearestDelivery = false;
    row.nearestPickupRank = null;
    row.nearestDeliveryRank = null;
    row.tripDistanceKm = Number.isFinite(tripKm(row)) ? Number(tripKm(row).toFixed(2)) : null;
  }

  const sorted = sortNearestTrip(rows);
  // Keep caller array order in sync with sorted order.
  rows.length = 0;
  rows.push(...sorted);

  rankLeg(rows, 'pickupDistanceKm', 'nearestPickupRank', 'isNearestPickup');
  rankLeg(rows, 'deliveryDistanceKm', 'nearestDeliveryRank', 'isNearestDelivery');
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
  tripKm,
  compareNearestTrip,
  sortNearestTrip,
  applyNearestDistanceRanks,
  computeShopOrderDistances,
  sortAssignableShops,
};
