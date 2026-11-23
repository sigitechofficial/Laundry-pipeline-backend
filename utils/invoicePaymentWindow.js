'use strict';

/**
 * Invoice payment window: after pickup the shop has a fixed time (runtime setting
 * invoicePaymentWindowMinutes) to collect payment / finalise the invoice when the
 * window applies (paymentSummary.invoicePaymentWindowApplies).
 *
 * The deadline is an absolute instant derived from booking.pickupCompletedAt, so
 * every device shows the same countdown regardless of its clock zone or restarts.
 * (It used to be "now + 60 minutes" computed in Asia/Karachi on every request — a
 * constant 60 that reset whenever the invoice was reloaded.)
 */
function paymentWindowEndsAt(pickupCompletedAt, windowMinutes) {
  if (!pickupCompletedAt) return null;
  const start = new Date(pickupCompletedAt);
  const minutes = Number(windowMinutes);
  if (Number.isNaN(start.getTime()) || !Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(start.getTime() + minutes * 60 * 1000);
}

/** Whole minutes left until [endsAt] (0 once passed); null without a deadline. */
function remainingMinutes(endsAt, now = Date.now()) {
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 60000));
}

module.exports = { paymentWindowEndsAt, remainingMinutes };
