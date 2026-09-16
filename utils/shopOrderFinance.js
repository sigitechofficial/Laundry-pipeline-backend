'use strict';

const { money } = require('../services/Admin/shopRevenuePeriod');
const { classifySlotTiming } = require('./bookingPunctuality');
const { bookingTipAmountFromTips } = require('./bookingTips');

/**
 * Shop/admin money split for one booking.
 * Service fee is platform (admin) revenue — never shop net.
 */
function presentShopOrderFinance(plain, refundedAmount = 0) {
  const bill = plain.billingDetail || {};
  const drivers =
    money(bill.pickupDriverEarning) + money(bill.deliveryDriverEarning);
  const billedGross = money(bill.total != null ? bill.total : plain.orderAmount);
  const refunded = money(refundedAmount);
  const gross = money(Math.max(0, billedGross - refunded));
  const fullyRefunded = gross <= 0.02;
  const serviceCharge = money(bill.serviceCharge);
  const platformCommission = fullyRefunded ? 0 : money(bill.zoneAdminCommission);
  const billedShopNet =
    bill.agentEarning != null && bill.agentEarning !== ''
      ? money(bill.agentEarning)
      : null;
  const derivedShopNet = money(
    Math.max(
      0,
      gross -
        platformCommission -
        serviceCharge -
        drivers -
        money(plain.rescheduleCharge)
    )
  );
  const hasRefund = refunded > 0.02;

  // Agent-built invoices historically never stored categoryCharge; derive the
  // laundry line from the invoice value (laundry + fee + booking tip) instead
  // of reporting £0.00.
  const storedLaundry = money(bill.categoryCharge);
  const invoiceValue = money(plain.orderAmount != null ? plain.orderAmount : bill.total);
  const bookingTip =
    plain.bookingTipAmount != null
      ? money(plain.bookingTipAmount)
      : Array.isArray(plain.tips)
        ? money(bookingTipAmountFromTips(plain.tips))
        : 0;
  const laundry =
    storedLaundry > 0
      ? storedLaundry
      : money(Math.max(0, invoiceValue - serviceCharge - bookingTip));

  // Billed agentEarning is the source of truth until a customer refund lands.
  // After that, remaining gross drives the split so shop net cannot stay at
  // the pre-refund invoice share.
  const shopNet = fullyRefunded
    ? 0
    : billedShopNet != null && !hasRefund
      ? billedShopNet
      : derivedShopNet;

  return {
    gross,
    laundry,
    serviceCharge,
    discount: money(bill.discount),
    platformCommission,
    platformTake: fullyRefunded ? 0 : money(platformCommission + serviceCharge),
    shopNet,
    driverEarnings: fullyRefunded ? 0 : drivers,
    isFullyRefunded: fullyRefunded,
    pickupTiming: classifySlotTiming(
      plain.pickupCompletedAt,
      plain.collectionDate,
      plain.collectionTimeFrom,
      plain.collectionTimeTo
    ),
    deliveryTiming: classifySlotTiming(
      plain.deliveryCompletedAt,
      plain.deliveryDate,
      plain.deliveryTimeFrom,
      plain.deliveryTimeTo
    ),
  };
}

module.exports = {
  presentShopOrderFinance,
};
