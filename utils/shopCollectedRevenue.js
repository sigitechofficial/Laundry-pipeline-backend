"use strict";

const { COLLECTED_SQL } = require("../constants/bookingStatusIds");

/**
 * Per-shop collected revenue: invoice/order total minus customer refunds.
 * Pending, cancelled, and fully refunded bookings do not count.
 *
 * @param {string} addressIdExpr SQL expression for laundryShopId, e.g. `addressDb.id`
 */
function shopCollectedNetRevenueSql(addressIdExpr) {
  const shopId = addressIdExpr || "addressDb.id";
  return `(
    SELECT ROUND(COALESCE(SUM(GREATEST(0,
      COALESCE(bd.total, b.orderAmount, 0) - COALESCE(rf.refunded, 0)
    )), 0), 2)
    FROM bookings AS b
    LEFT JOIN billingDetails AS bd ON bd.bookingId = b.id
    LEFT JOIN (
      SELECT bookingId, SUM(amount) AS refunded
      FROM booking_refunds
      WHERE status IN ('succeeded', 'partial_failed')
        AND deletedAt IS NULL
      GROUP BY bookingId
    ) AS rf ON rf.bookingId = b.id
    WHERE b.laundryShopId = ${shopId}
      AND b.deletedAt IS NULL
      AND b.bookingStatusId IN (${COLLECTED_SQL})
      AND GREATEST(0, COALESCE(bd.total, b.orderAmount, 0) - COALESCE(rf.refunded, 0)) > 0.02
  )`;
}

module.exports = {
  shopCollectedNetRevenueSql,
};
