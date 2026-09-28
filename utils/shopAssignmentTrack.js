'use strict';

/**
 * Pure summary for Order Details: original shop + current (last toShop).
 * Kept free of models so unit tests can run without config.json.
 */
function summarizeShopTrack(events = []) {
  if (!Array.isArray(events) || !events.length) {
    return {
      originalShopId: null,
      originalShopName: null,
      currentShopId: null,
      currentShopName: null,
      reassignCount: 0,
    };
  }
  const first = events[0];
  const last = events[events.length - 1];
  const reassignCount = events.filter((e) => e.fromShopId != null).length;
  return {
    originalShopId: first.toShopId,
    originalShopName: first.toShopName,
    currentShopId: last.toShopId,
    currentShopName: last.toShopName,
    reassignCount,
  };
}

module.exports = {
  summarizeShopTrack,
};
