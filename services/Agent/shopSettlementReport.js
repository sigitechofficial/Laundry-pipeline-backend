"use strict";

const sequelize = require("../../models").sequelize;
const { booking, billingDetails, bookingRefund } = require("../../models");
const {
  CASH_CHANNEL_SQL,
  MIXED_CHANNEL_SQL,
} = require("../../utils/earningChannel");
const {
  emptySettlementReport,
  mapSettlementReport,
} = require("../../utils/shopSettlementReportMap");

const T = {
  bookings: booking.getTableName(),
  billing: billingDetails.getTableName(),
  refunds: bookingRefund.getTableName(),
};

const REFUND_JOIN = `
    LEFT JOIN (
      SELECT bookingId, SUM(amount) AS refunded
      FROM \`${T.refunds}\`
      WHERE status IN ('succeeded', 'partial_failed')
        AND deletedAt IS NULL
      GROUP BY bookingId
    ) rf ON rf.bookingId = b.id
`;
const NET_GROSS =
  "GREATEST(0, COALESCE(bd.total, b.orderAmount, 0) - COALESCE(rf.refunded, 0))";
const STILL = `${NET_GROSS} > 0.02`;
const DRIVER_PAY =
  "(COALESCE(bd.pickupDriverEarning, 0) + COALESCE(bd.deliveryDriverEarning, 0))";
const SHOP_NET = `(CASE
  WHEN ${STILL} AND bd.agentEarning IS NOT NULL AND COALESCE(rf.refunded, 0) <= 0.02
    THEN bd.agentEarning
  WHEN ${STILL} THEN
    ${NET_GROSS}
      - COALESCE(bd.zoneAdminCommission, 0)
      - COALESCE(bd.serviceCharge, 0)
      - ${DRIVER_PAY}
      - COALESCE(b.rescheduleCharge, 0)
  ELSE 0
END)`;
const PLATFORM_TAKE =
  "COALESCE(bd.zoneAdminCommission, 0) + COALESCE(bd.serviceCharge, 0)";

/**
 * Lifetime paid-order money + card/cash customer report for one shop address.
 * Same Paid-invoice set as the settlement order list; amounts net customer refunds.
 */
async function loadShopSettlementReport(laundryShopId) {
  const addressId = parseInt(laundryShopId, 10);
  if (!Number.isFinite(addressId) || addressId <= 0) {
    return emptySettlementReport();
  }

  const [rows] = await sequelize.query(
    `
    SELECT
      COUNT(DISTINCT b.id) AS ordersPaid,
      COUNT(DISTINCT b.customerId) AS customers,

      COUNT(DISTINCT CASE WHEN ${CASH_CHANNEL_SQL} THEN b.id END) AS cashOrders,
      COUNT(DISTINCT CASE WHEN NOT (${CASH_CHANNEL_SQL}) THEN b.id END) AS cardOrders,
      COUNT(DISTINCT CASE WHEN ${MIXED_CHANNEL_SQL} THEN b.id END) AS mixedOrders,
      COUNT(DISTINCT CASE WHEN ${CASH_CHANNEL_SQL} THEN b.customerId END) AS cashCustomers,
      COUNT(DISTINCT CASE WHEN NOT (${CASH_CHANNEL_SQL}) THEN b.customerId END) AS cardCustomers,
      COUNT(DISTINCT CASE WHEN ${MIXED_CHANNEL_SQL} THEN b.customerId END) AS mixedCustomers,

      COALESCE(SUM(CASE WHEN ${STILL} THEN ${NET_GROSS} ELSE 0 END), 0) AS gross,
      COALESCE(SUM(CASE WHEN ${STILL} THEN bd.categoryCharge ELSE 0 END), 0) AS laundry,
      COALESCE(SUM(CASE WHEN ${STILL} THEN bd.serviceCharge ELSE 0 END), 0) AS serviceFee,
      COALESCE(SUM(CASE WHEN ${STILL} THEN bd.zoneAdminCommission ELSE 0 END), 0) AS platformCommission,
      COALESCE(SUM(CASE WHEN ${STILL} THEN ${PLATFORM_TAKE} ELSE 0 END), 0) AS platformTake,
      COALESCE(SUM(CASE WHEN ${STILL} THEN ${SHOP_NET} ELSE 0 END), 0) AS shopNet,
      COALESCE(SUM(CASE WHEN ${STILL} THEN ${DRIVER_PAY} ELSE 0 END), 0) AS driverEarnings,
      COALESCE(SUM(CASE WHEN ${STILL} THEN bd.discount ELSE 0 END), 0) AS discount,

      COALESCE(SUM(CASE WHEN ${STILL} AND ${CASH_CHANNEL_SQL} THEN ${NET_GROSS} ELSE 0 END), 0) AS cashGross,
      COALESCE(SUM(CASE WHEN ${STILL} AND NOT (${CASH_CHANNEL_SQL}) THEN ${NET_GROSS} ELSE 0 END), 0) AS cardGross,
      COALESCE(SUM(CASE WHEN ${STILL} AND ${MIXED_CHANNEL_SQL} THEN ${NET_GROSS} ELSE 0 END), 0) AS mixedGross,

      COALESCE(SUM(CASE WHEN ${STILL} AND ${CASH_CHANNEL_SQL} THEN bd.categoryCharge ELSE 0 END), 0) AS cashLaundry,
      COALESCE(SUM(CASE WHEN ${STILL} AND NOT (${CASH_CHANNEL_SQL}) THEN bd.categoryCharge ELSE 0 END), 0) AS cardLaundry,
      COALESCE(SUM(CASE WHEN ${STILL} AND ${MIXED_CHANNEL_SQL} THEN bd.categoryCharge ELSE 0 END), 0) AS mixedLaundry,

      COALESCE(SUM(CASE WHEN ${STILL} AND ${CASH_CHANNEL_SQL} THEN bd.serviceCharge ELSE 0 END), 0) AS cashServiceFee,
      COALESCE(SUM(CASE WHEN ${STILL} AND NOT (${CASH_CHANNEL_SQL}) THEN bd.serviceCharge ELSE 0 END), 0) AS cardServiceFee,
      COALESCE(SUM(CASE WHEN ${STILL} AND ${MIXED_CHANNEL_SQL} THEN bd.serviceCharge ELSE 0 END), 0) AS mixedServiceFee,

      COALESCE(SUM(CASE WHEN ${STILL} AND ${CASH_CHANNEL_SQL} THEN bd.zoneAdminCommission ELSE 0 END), 0) AS cashCommission,
      COALESCE(SUM(CASE WHEN ${STILL} AND NOT (${CASH_CHANNEL_SQL}) THEN bd.zoneAdminCommission ELSE 0 END), 0) AS cardCommission,
      COALESCE(SUM(CASE WHEN ${STILL} AND ${MIXED_CHANNEL_SQL} THEN bd.zoneAdminCommission ELSE 0 END), 0) AS mixedCommission,

      COALESCE(SUM(CASE WHEN ${STILL} AND ${CASH_CHANNEL_SQL} THEN ${PLATFORM_TAKE} ELSE 0 END), 0) AS cashPlatformTake,
      COALESCE(SUM(CASE WHEN ${STILL} AND NOT (${CASH_CHANNEL_SQL}) THEN ${PLATFORM_TAKE} ELSE 0 END), 0) AS cardPlatformTake,
      COALESCE(SUM(CASE WHEN ${STILL} AND ${MIXED_CHANNEL_SQL} THEN ${PLATFORM_TAKE} ELSE 0 END), 0) AS mixedPlatformTake,

      COALESCE(SUM(CASE WHEN ${STILL} AND ${CASH_CHANNEL_SQL} THEN ${SHOP_NET} ELSE 0 END), 0) AS cashShopNet,
      COALESCE(SUM(CASE WHEN ${STILL} AND NOT (${CASH_CHANNEL_SQL}) THEN ${SHOP_NET} ELSE 0 END), 0) AS cardShopNet,
      COALESCE(SUM(CASE WHEN ${STILL} AND ${MIXED_CHANNEL_SQL} THEN ${SHOP_NET} ELSE 0 END), 0) AS mixedShopNet
    FROM \`${T.bookings}\` b
    INNER JOIN \`${T.billing}\` bd ON bd.bookingId = b.id AND bd.paymentStatus = 'Paid'
    ${REFUND_JOIN}
    WHERE b.laundryShopId = :addressId
      AND b.deletedAt IS NULL
    `,
    { replacements: { addressId } }
  );

  return mapSettlementReport(rows && rows[0]);
}

module.exports = {
  loadShopSettlementReport,
};
