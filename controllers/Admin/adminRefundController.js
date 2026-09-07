'use strict';

const ResponseHelper = require('../../utils/responseHelper');
const adminRefundService = require('../../services/Admin/adminRefundService');
const {
  ValidationError,
  NotFoundError,
} = require('../../middlewares/universalErrorHandler');

exports.getRefundPreview = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId || req.params.id, 10);
  if (!bookingId) throw new ValidationError('bookingId is required');

  const amount =
    req.query.amount != null && req.query.amount !== ''
      ? Number(req.query.amount)
      : null;

  try {
    const data = await adminRefundService.buildRefundPreview(bookingId, amount);
    return ResponseHelper.success(res, 'Refund preview', data);
  } catch (err) {
    if (err.statusCode === 404) throw new NotFoundError(err.message);
    if (err.statusCode === 400) throw new ValidationError(err.message);
    throw err;
  }
};

exports.issueRefund = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId || req.params.id, 10);
  if (!bookingId) throw new ValidationError('bookingId is required');

  const body = req.body || {};
  try {
    const data = await adminRefundService.issueRefund(
      bookingId,
      {
        amount: body.amount,
        mode: body.mode,
        reason: body.reason,
        note: body.note,
        idempotencyKey: body.idempotencyKey,
      },
      req.user?.id || null
    );
    return ResponseHelper.success(res, data.message || 'Refund issued', data);
  } catch (err) {
    if (err.statusCode === 404) throw new NotFoundError(err.message);
    if (err.statusCode === 400) throw new ValidationError(err.message);
    throw err;
  }
};

exports.listRefunds = async (req, res) => {
  const bookingId = parseInt(req.params.bookingId || req.params.id, 10);
  if (!bookingId) throw new ValidationError('bookingId is required');
  const data = await adminRefundService.listRefundsForBooking(bookingId);
  return ResponseHelper.success(res, 'Booking refunds', { refunds: data });
};
