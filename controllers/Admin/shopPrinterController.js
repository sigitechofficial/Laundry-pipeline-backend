'use strict';

const db = require('../../models');
const ResponseHelper = require('../../utils/responseHelper');
const {
  ValidationError,
  NotFoundError,
} = require('../../middlewares/universalErrorHandler');
const { getShopPrinter, saveShopPrinter } = require('../../services/printing/shopPrinterService');
const printJobService = require('../../services/printing/printJobService');
const { notifyShopDevices } = require('../../services/printing/printJobNotifier');

const { booking, addressDb } = db;

function positiveIntParam(req, name) {
  const value = Number(req.params[name]);
  if (!Number.isInteger(value) || value <= 0) throw new ValidationError(`${name} required`);
  return value;
}

async function shopOwnerForBooking(bookingId) {
  const row = await booking.findByPk(bookingId, { attributes: ['id', 'laundryShopId'] });
  if (!row) throw new NotFoundError('Order not found');
  if (!row.laundryShopId) {
    throw new ValidationError('This order has no shop yet. Tags can be printed once a shop accepts it.');
  }
  const shop = await addressDb.findByPk(row.laundryShopId, { attributes: ['id', 'userId'] });
  if (!shop?.userId) throw new ValidationError('Could not resolve the shop for this order');
  return Number(shop.userId);
}

exports.getShopPrinter = async (req, res) => {
  const shopUserId = positiveIntParam(req, 'shopId');
  const printer = await getShopPrinter(shopUserId);
  return ResponseHelper.success(res, 'Shop printer', { shopUserId, printer });
};

exports.putShopPrinter = async (req, res) => {
  const shopUserId = positiveIntParam(req, 'shopId');
  const printer = await saveShopPrinter(shopUserId, req.body);
  return ResponseHelper.success(res, 'Shop printer saved', { shopUserId, printer });
};

exports.testShopPrinter = async (req, res) => {
  const shopUserId = positiveIntParam(req, 'shopId');
  const job = await printJobService.createJob(
    { shopUserId, kind: 'test', requestedByUserId: req.user?.id || null },
    notifyShopDevices
  );
  return ResponseHelper.success(res, 'Test print sent to the shop app', { job });
};

exports.getShopPrintJob = async (req, res) => {
  const shopUserId = positiveIntParam(req, 'shopId');
  const job = await printJobService.getJob(positiveIntParam(req, 'jobId'));
  if (job.shopUserId !== shopUserId) throw new NotFoundError('Print job not found');
  return ResponseHelper.success(res, 'Print job', { job });
};

exports.printBookingTags = async (req, res) => {
  const bookingId = positiveIntParam(req, 'bookingId');
  const shopUserId = await shopOwnerForBooking(bookingId);
  const job = await printJobService.createJob(
    { shopUserId, bookingId, kind: 'tags', requestedByUserId: req.user?.id || null },
    notifyShopDevices
  );
  return ResponseHelper.success(res, 'Tags sent to the shop app', { job });
};

exports.getBookingPrintJob = async (req, res) => {
  const bookingId = positiveIntParam(req, 'bookingId');
  const job = await printJobService.getJob(positiveIntParam(req, 'jobId'));
  if (job.bookingId !== bookingId) throw new NotFoundError('Print job not found');
  return ResponseHelper.success(res, 'Print job', { job });
};
