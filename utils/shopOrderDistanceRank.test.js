'use strict';

const assert = require('assert');
const {
  sortByPickupThenDelivery,
  applyNearestDistanceRanks,
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
    { id: 10, pickupDistanceKm: 5.2, deliveryDistanceKm: 1.0 },
    { id: 20, pickupDistanceKm: 0.8, deliveryDistanceKm: 4.0 },
    { id: 30, pickupDistanceKm: 2.1, deliveryDistanceKm: 0.5 },
    { id: 40, pickupDistanceKm: 9.0, deliveryDistanceKm: 9.0 },
    { id: 50, pickupDistanceKm: null, deliveryDistanceKm: 0.2 },
  ];
  applyNearestDistanceRanks(rows);

  assert.strictEqual(rows[0].id, 20, 'nearest pickup first');
  assert.strictEqual(rows[1].id, 30);
  assert.strictEqual(rows[2].id, 10);
  assert.strictEqual(rows[0].nearestPickupRank, 1);
  assert.strictEqual(rows[0].isNearestPickup, true);
  assert.strictEqual(rows[1].nearestPickupRank, 2);
  assert.strictEqual(rows[2].nearestPickupRank, 3);
  assert.strictEqual(rows[3].nearestPickupRank, null, '4th has no top-3 badge');

  // Delivery ranks independent of list order
  const d1 = rows.find((r) => r.nearestDeliveryRank === 1);
  assert.ok(d1);
  assert.strictEqual(d1.id, 50, 'nearest delivery is closest drop-off');
  assert.strictEqual(d1.isNearestDelivery, true);
  assert.strictEqual(
    rows.filter((r) => r.nearestDeliveryRank != null).length,
    3
  );
}

{
  // After "accepting" nearest (remove id 20), ranks shift
  const rows = [
    { id: 20, pickupDistanceKm: 0.8, deliveryDistanceKm: 4.0 },
    { id: 30, pickupDistanceKm: 2.1, deliveryDistanceKm: 0.5 },
    { id: 10, pickupDistanceKm: 5.2, deliveryDistanceKm: 1.0 },
  ];
  applyNearestDistanceRanks(rows);
  rows.splice(0, 1); // simulate accept nearest 1
  applyNearestDistanceRanks(rows);
  assert.strictEqual(rows[0].id, 30);
  assert.strictEqual(rows[0].nearestPickupRank, 1);
  assert.strictEqual(rows[1].nearestPickupRank, 2);
}

{
  const sorted = sortByPickupThenDelivery([
    { id: 1, pickupDistanceKm: null, deliveryDistanceKm: 1 },
    { id: 2, pickupDistanceKm: 3, deliveryDistanceKm: 9 },
  ]);
  assert.strictEqual(sorted[0].id, 2, 'known distance before null');
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

// ── Shop → order distances (broadcast, preferred offer, home list) ──────────
(async () => {
  const { computeShopOrderDistances } = require('./shopOrderDistanceRank');
  const shop = { lat: '51.5074', lng: '-0.1278' };
  const pickup = { lat: '51.5155', lng: '-0.1420' };
  const dropOff = { lat: 51.5074, lng: -0.1278 };

  const both = await computeShopOrderDistances(shop.lat, shop.lng, pickup, dropOff);
  assert.ok(both.pickupDistanceKm > 1 && both.pickupDistanceKm < 1.6, `pickup km ${both.pickupDistanceKm}`);
  assert.strictEqual(both.deliveryDistanceKm, 0);

  assert.deepStrictEqual(
    await computeShopOrderDistances(null, null, pickup, dropOff),
    { pickupDistanceKm: null, deliveryDistanceKm: null },
    'shop without coordinates'
  );
  assert.deepStrictEqual(
    await computeShopOrderDistances('0', '0', pickup, dropOff),
    { pickupDistanceKm: null, deliveryDistanceKm: null },
    'ungeocoded 0,0 shop'
  );
  assert.deepStrictEqual(
    await computeShopOrderDistances(shop.lat, shop.lng, pickup, undefined),
    { pickupDistanceKm: both.pickupDistanceKm, deliveryDistanceKm: null },
    'no drop-off address'
  );
  assert.deepStrictEqual(
    await computeShopOrderDistances(shop.lat, shop.lng, { lat: '', lng: 'x' }, {}),
    { pickupDistanceKm: null, deliveryDistanceKm: null },
    'bad address coordinates'
  );

  console.log('shopOrderDistanceRank + related feature tests: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
