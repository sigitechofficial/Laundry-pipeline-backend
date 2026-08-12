'use strict';

const { sendEvent } = require('../socket_io');
const { sendNotification } = require('./notification');

/**
 * Ask the customer to leave a shop review after delivery/completion.
 * Fire-and-forget — must not block the delivery flow.
 */
async function notifyCustomerRequestReview({
  customerId,
  bookingId,
  orderTrackId,
}) {
  if (customerId == null) return;
  const id = Number(customerId);
  if (!id || Number.isNaN(id)) return;

  const numericBookingId = Number(bookingId);
  const orderLabel = orderTrackId || String(bookingId);
  const title = 'Rate your laundry order';
  const body = `How was order #${orderLabel}? Tap to leave a quick rating and review.`;
  const data = {
    type: 'requestShopReview',
    bookingId: numericBookingId,
    orderTrackId: orderTrackId || '',
  };

  try {
    await sendEvent(id, {
      type: 'requestShopReview',
      data: {
        bookingId: numericBookingId,
        orderTrackId: orderTrackId || null,
        message: body,
      },
    });
  } catch (err) {
    console.warn('[reviewNotify] customer sendEvent failed:', err?.message || err);
  }

  try {
    await sendNotification(id, title, body, data);
  } catch (err) {
    console.warn(
      '[reviewNotify] customer sendNotification failed:',
      err?.message || err
    );
  }
}

/**
 * Notify the shop owner when a customer submits a review.
 * Fire-and-forget.
 */
async function notifyShopReviewSubmitted({
  shopOwnerUserId,
  bookingId,
  orderTrackId,
  rating,
}) {
  if (shopOwnerUserId == null) return;
  const id = Number(shopOwnerUserId);
  if (!id || Number.isNaN(id)) return;

  const numericBookingId = Number(bookingId);
  const orderLabel = orderTrackId || String(bookingId);
  const stars = Number(rating) || 0;
  const title = 'New customer review';
  const body = `Order #${orderLabel} received a ${stars}★ rating. Tap to view.`;
  const data = {
    type: 'shopReviewSubmitted',
    bookingId: numericBookingId,
    orderTrackId: orderTrackId || '',
    rating: stars,
  };

  try {
    await sendEvent(id, {
      type: 'shopReviewSubmitted',
      data: {
        bookingId: numericBookingId,
        orderTrackId: orderTrackId || null,
        rating: stars,
        message: body,
      },
    });
  } catch (err) {
    console.warn('[reviewNotify] shop sendEvent failed:', err?.message || err);
  }

  try {
    await sendNotification(id, title, body, data);
  } catch (err) {
    console.warn(
      '[reviewNotify] shop sendNotification failed:',
      err?.message || err
    );
  }
}

module.exports = {
  notifyCustomerRequestReview,
  notifyShopReviewSubmitted,
};
