'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  rankByNearestRoute,
  sortLaneByRoute,
  latLngOf,
} = require('../utils/shopLiveOpsRouteRank');

describe('shopLiveOpsRouteRank.rankByNearestRoute', () => {
  it('orders stops nearest-first from shop origin', () => {
    const origin = { lat: 51.57786, lng: -0.20764 };
    const items = [
      { id: 'far', pickupAddress: { lat: '51.59', lng: '-0.21' } },
      { id: 'near', pickupAddress: { lat: '51.578', lng: '-0.2075' } },
      { id: 'mid', pickupAddress: { lat: '51.582', lng: '-0.209' } },
    ];
    const ranked = rankByNearestRoute(items, origin, (o) => {
      const lat = Number(o.pickupAddress.lat);
      const lng = Number(o.pickupAddress.lng);
      return { lat, lng };
    });
    assert.equal(ranked[0].id, 'near');
    assert.equal(ranked[0].stopRank, 1);
    assert.ok(ranked[0].legKm != null && ranked[0].legKm >= 0);
    assert.equal(ranked[1].stopRank, 2);
    assert.equal(ranked[2].stopRank, 3);
  });

  it('keeps unlocated items after located stops', () => {
    const origin = { lat: 51.57, lng: -0.2 };
    const items = [
      { id: 'no-coords', pickupAddress: {} },
      { id: 'ok', pickupAddress: { lat: '51.571', lng: '-0.201' } },
    ];
    const ranked = rankByNearestRoute(items, origin, (o) => {
      const lat = Number(o.pickupAddress?.lat);
      const lng = Number(o.pickupAddress?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    });
    assert.equal(ranked[0].id, 'ok');
    assert.equal(ranked[1].id, 'no-coords');
    assert.equal(ranked[1].stopRank, null);
  });
});

describe('shopLiveOpsRouteRank.sortLaneByRoute', () => {
  it('keeps earlier slots before later slots and ranks within slot', () => {
    const origin = { lat: 51.57786, lng: -0.20764 };
    const orders = [
      {
        id: 'late-near',
        collectionDate: '2026-10-01',
        collectionTimeFrom: '11:00',
        pickupAddress: { lat: '51.578', lng: '-0.2075' },
      },
      {
        id: 'early-far',
        collectionDate: '2026-10-01',
        collectionTimeFrom: '09:00',
        pickupAddress: { lat: '51.59', lng: '-0.21' },
      },
      {
        id: 'early-near',
        collectionDate: '2026-10-01',
        collectionTimeFrom: '09:00',
        pickupAddress: { lat: '51.578', lng: '-0.2075' },
      },
    ];
    const ranked = sortLaneByRoute(orders, origin, 'pickup');
    assert.equal(ranked[0].id, 'early-near');
    assert.equal(ranked[0].stopRank, 1);
    assert.equal(ranked[1].id, 'early-far');
    assert.equal(ranked[1].stopRank, 2);
    assert.equal(ranked[2].id, 'late-near');
    assert.equal(ranked[2].stopRank, 3);
  });

  it('latLngOf rejects 0,0 placeholders', () => {
    assert.equal(latLngOf({ lat: '0', lng: '0' }), null);
    assert.ok(latLngOf({ lat: '51.5', lng: '-0.2' }));
  });
});
