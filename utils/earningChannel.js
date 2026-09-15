"use strict";

const { normalizePaymentType } = require("./invoicePaymentSummary");

/**
 * Cash bucket: full cash bookings + card booked with the balance collected in cash.
 * Card bucket: remaining card bookings.
 * Keep SQL `CASH_CHANNEL_SQL` in lockstep with this function.
 */
function classifyAgentEarningChannel(bookingRow) {
  if (!bookingRow) return "card";

  const paymentType = normalizePaymentType(bookingRow.paymentType);
  if (paymentType === "cash") {
    return "cash";
  }

  const collectedVia = bookingRow.balanceCollectedVia;
  if (collectedVia === "cash") {
    return "cash";
  }
  if (collectedVia === "card") {
    return "card";
  }

  if (bookingRow.balancePaymentMethod === "cash") {
    return "cash";
  }

  return "card";
}

/** Card booking whose remaining balance was taken in cash. */
function isMixedPayChannel(bookingRow) {
  if (!bookingRow) return false;
  if (normalizePaymentType(bookingRow.paymentType) === "cash") return false;
  return classifyAgentEarningChannel(bookingRow) === "cash";
}

/**
 * SQL fragment against bookings alias `b`. True when the earning channel is cash.
 */
const CASH_CHANNEL_SQL = `(
  LOWER(TRIM(COALESCE(b.paymentType, 'card'))) = 'cash'
  OR (
    LOWER(TRIM(COALESCE(b.paymentType, 'card'))) <> 'cash'
    AND (
      b.balanceCollectedVia = 'cash'
      OR (
        (b.balanceCollectedVia IS NULL OR b.balanceCollectedVia = '')
        AND b.balancePaymentMethod = 'cash'
      )
    )
  )
)`;

/** Card booked, remainder collected in cash — subset of cash channel. */
const MIXED_CHANNEL_SQL = `(
  LOWER(TRIM(COALESCE(b.paymentType, 'card'))) <> 'cash'
  AND (
    b.balanceCollectedVia = 'cash'
    OR (
      (b.balanceCollectedVia IS NULL OR b.balanceCollectedVia = '')
      AND b.balancePaymentMethod = 'cash'
    )
  )
)`;

function customersWhoUsedBoth(cashCustomers, cardCustomers, uniqueCustomers) {
  const cash = Number(cashCustomers) || 0;
  const card = Number(cardCustomers) || 0;
  const unique = Number(uniqueCustomers) || 0;
  return Math.max(0, cash + card - unique);
}

module.exports = {
  classifyAgentEarningChannel,
  isMixedPayChannel,
  CASH_CHANNEL_SQL,
  MIXED_CHANNEL_SQL,
  customersWhoUsedBoth,
};
