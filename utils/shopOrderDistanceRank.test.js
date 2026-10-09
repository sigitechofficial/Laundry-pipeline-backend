'use strict';

const assert = require('assert');
const {
  sortNearestTrip,
  tripKm,
  applyNearestDistanceRanks,
  computeShopOrderDistances,
  sortAssignableShops,
} = require('./shopOrderDistanceRank');
const {
  buildDeclineReasonBreakdown,
  normalizeDeclineReason,
} = require('../constants/agentDeclineReasons');
const { summarizeShopTrack } = require('./shopAssignmentTrack');
const { couponAppliesToZone, parseZoneIds } = require('./couponDiscount');

// ── Distance rank / top-3 badges ─────────────────────────────────────────────
{
  const rows = [
    { id: 10, pickupDistanceKm: 5.2, deliveryDistanceKm: 1.0 }, // trip 6.2
    { id: 20, pickupDistanceKm: 0.8, deliveryDistanceKm: 4.0 }, // trip 4.8
    { id: 30, pickupDistanceKm: 2.1, deliveryDistanceKm: 0.5 }, // trip 2.6
    { id: 40, pickupDistanceKm: 9.0, deliveryDistanceKm: 9.0 }, // trip 18
    { id: 50, pickupDistanceKm: null, deliveryDistanceKm: 0.2 }, // unknown pickup → last
  ];
  applyNearestDistanceRanks(rows);

  assert.deepStrictEqual(rows.map((r) => r.id), [30, 20, 10, 40, 50], 'least total trip first');
  assert.strictEqual(rows[0].tripDistanceKm, 2.6);
  assert.strictEqual(rows[4].tripDistanceKm, null);

  // Pickup badges follow pickup distance, not list order
  const p = (id) => rows.find((r) => r.id === id);
  assert.strictEqual(p(20).nearestPickupRank, 1);
  assert.strictEqual(p(20).isNearestPickup, true);
  assert.strictEqual(p(30).nearestPickupRank, 2);
  assert.strictEqual(p(10).nearestPickupRank, 3);
  assert.strictEqual(p(40).nearestPickupRank, null, '4th has no top-3 badge');

  // Delivery ranks independent of list order
  assert.strictEqual(p(50).nearestDeliveryRank, 1, 'nearest delivery is closest drop-off');
  assert.strictEqual(p(50).isNearestDelivery, true);
  assert.strictEqual(p(30).nearestDeliveryRank, 2);
  assert.strictEqual(rows.filter((r) => r.nearestDeliveryRank != null).length, 3);
}

{
  // After "accepting" the first one, ranks shift
  const rows = [
    { id: 20, pickupDistanceKm: 0.8, deliveryDistanceKm: 4.0 },
    { id: 30, pickupDistanceKm: 2.1, deliveryDistanceKm: 0.5 },
    { id: 10, pickupDistanceKm: 5.2, deliveryDistanceKm: 1.0 },
  ];
  applyNearestDistanceRanks(rows);
  rows.splice(0, 1); // simulate accept of the top order (30)
  applyNearestDistanceRanks(rows);
  assert.deepStrictEqual(rows.map((r) => r.id), [20, 10]);
  assert.strictEqual(rows[0].nearestPickupRank, 1);
}

{
  // A single order must survive (the list is cleared and refilled in place).
  const one = [{ id: 7, pickupDistanceKm: 1.2, deliveryDistanceKm: 1.2 }];
  applyNearestDistanceRanks(one);
  assert.strictEqual(one.length, 1, 'one order stays in the list');
  assert.strictEqual(one[0].nearestPickupRank, 1);
}

{
  const sorted = sortNearestTrip([
    { id: 1, pickupDistanceKm: null, deliveryDistanceKm: 1 },
    { id: 2, pickupDistanceKm: 3, deliveryDistanceKm: 9 },
  ]);
  assert.strictEqual(sorted[0].id, 2, 'known distance before null');

  // Missing drop-off distance counts as the pickup distance (same address)
  assert.strictEqual(tripKm({ pickupDistanceKm: 2, deliveryDistanceKm: null }), 4);

  // Same trip: nearer pickup first, then the sooner pickup slot
  const tie = sortNearestTrip([
    { id: 1, pickupDistanceKm: 3, deliveryDistanceKm: 1, collectionDate: '2026-10-12', collectionTimeFrom: '09:00' },
    { id: 2, pickupDistanceKm: 1, deliveryDistanceKm: 3, collectionDate: '2026-10-12', collectionTimeFrom: '09:00' },
    { id: 3, pickupDistanceKm: 1, deliveryDistanceKm: 3, collectionDate: '2026-10-11', collectionTimeFrom: '15:00' },
  ]);
  assert.deepStrictEqual(tie.map((r) => r.id), [3, 2, 1]);
}

// ── Shop → order distances (used when notifying shops of a new booking) ──────
(async () => {
  // Charing Cross shop; pickup ≈ Golders Green (~8 km), drop-off has no coords.
  const d = await computeShopOrderDistances(
    51.5074,
    -0.1278,
    { lat: '51.5724', lng: '-0.1941' },
    { lat: null, lng: undefined }
  );
  assert.ok(Math.abs(d.pickupDistanceKm - 8.4) < 0.3, 'pickup km');
  assert.strictEqual(d.deliveryDistanceKm, null, 'missing coords → null');

  const noShop = await computeShopOrderDistances(
    undefined,
    undefined,
    { lat: 51.5, lng: -0.1 },
    { lat: 51.6, lng: -0.2 }
  );
  assert.deepStrictEqual(noShop, {
    pickupDistanceKm: null,
    deliveryDistanceKm: null,
  });

  // null / (0,0) shop coordinates must be "unknown", not distance from (0,0).
  for (const [la, ln] of [[null, null], ['0', '0'], ['', '']]) {
    const r = await computeShopOrderDistances(la, ln, { lat: 51.5, lng: -0.1 }, null);
    assert.strictEqual(r.pickupDistanceKm, null, `shop coords ${la},${ln}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ── Admin assign-shop order: current first, nearest next, unknown last ───────
{
  const shops = sortAssignableShops([
    { shopName: 'Far', distanceKm: 9.1, customerOrdersAtShop: 5 },
    { shopName: 'NoGps', distanceKm: null, customerOrdersAtShop: 9 },
    { shopName: 'Near', distanceKm: 0.8, customerOrdersAtShop: 0 },
    { shopName: 'Current', distanceKm: 20, isCurrentShop: true },
    { shopName: 'B tie', distanceKm: 3, customerOrdersAtShop: 1 },
    { shopName: 'A tie', distanceKm: 3, customerOrdersAtShop: 1 },
    { shopName: 'Loyal tie', distanceKm: 3, customerOrdersAtShop: 4 },
  ]);
  assert.deepStrictEqual(
    shops.map((s) => s.shopName),
    ['Current', 'Near', 'Loyal tie', 'A tie', 'B tie', 'Far', 'NoGps']
  );
}

// ── Decline reason analytics ─────────────────────────────────────────────────
{
  const n = normalizeDeclineReason('Too busy / at capacity');
  assert.strictEqual(n.key, 'Too busy / at capacity');
  const fuzzy = normalizeDeclineReason('too much workload today');
  assert.strictEqual(fuzzy.key, 'Too busy / at capacity');
  const other = normalizeDeclineReason('rain flooded shop');
  assert.strictEqual(other.key, 'other');

  const breakdown = buildDeclineReasonBreakdown([
    { reason: 'Too busy / at capacity' },
    { reason: 'Too busy / at capacity' },
    { reason: 'Cannot meet pickup/delivery time' },
    { reason: null },
  ]);
  assert.strictEqual(breakdown[0].count, 2);
  assert.ok(breakdown.some((b) => b.key === 'unspecified'));
}

// ── Shop assignment track summary ────────────────────────────────────────────
{
  const track = summarizeShopTrack([
    {
      fromShopId: null,
      toShopId: 11,
      toShopName: 'Alpha',
    },
    {
      fromShopId: 11,
      toShopId: 22,
      toShopName: 'Beta',
      fromShopName: 'Alpha',
    },
  ]);
  assert.strictEqual(track.originalShopName, 'Alpha');
  assert.strictEqual(track.currentShopName, 'Beta');
  assert.strictEqual(track.reassignCount, 1);
  assert.deepStrictEqual(summarizeShopTrack([]).reassignCount, 0);
}

// ── Coupon zone filter (list semantics) ──────────────────────────────────────
{
  assert.strictEqual(couponAppliesToZone({ zoneIds: null }, 5), true);
  assert.strictEqual(couponAppliesToZone({ zoneIds: [] }, 5), true);
  assert.strictEqual(couponAppliesToZone({ zoneIds: [1, 5] }, 5), true);
  assert.strictEqual(couponAppliesToZone({ zoneIds: [1, 2] }, 5), false);
  assert.deepStrictEqual(parseZoneIds('[3,4]'), [3, 4]);

  const coupons = [
    { id: 1, zoneIds: null },
    { id: 2, zoneIds: [7] },
    { id: 3, zoneIds: [8, 9] },
  ];
  const zoneIdFilter = 7;
  const filtered = coupons.filter((c) => couponAppliesToZone(c, zoneIdFilter));
  assert.deepStrictEqual(
    filtered.map((c) => c.id).sort(),
    [1, 2],
    'all-zones + matching zone'
  );
}

console.log('shopOrderDistanceRank + related feature tests: OK');
