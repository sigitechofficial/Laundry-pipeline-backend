'use strict';

const path = require('path');
const bannerService = require('../../services/Admin/bannerService');
const ResponseHelper = require('../../utils/responseHelper');
const { StatusCodes } = require('http-status-codes');
const { ValidationError } = require('../../middlewares/universalErrorHandler');
const {
  pickBannerUpload,
  publicPathFromMulterFile,
} = require('../../utils/bannerPayload');

const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function resolveUploadedImage(req) {
  const file = pickBannerUpload(req);
  if (!file) return undefined;

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) {
    throw new ValidationError('Only jpg, png, webp, and gif images are allowed');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new ValidationError('Image must be 5MB or smaller');
  }

  return publicPathFromMulterFile(file);
}

function payloadFromRequest(req, { includeExistingImage = true } = {}) {
  const uploaded = resolveUploadedImage(req);
  const payload = { ...req.body };
  if (uploaded) {
    payload.bannerImage = uploaded;
  } else if (!includeExistingImage) {
    delete payload.bannerImage;
  }
  return payload;
}

async function createBanner(req, res) {
  const payload = payloadFromRequest(req);
  const result = await bannerService.createBanner(payload);
  return ResponseHelper.success(res, result.message, result.data, StatusCodes.CREATED);
}

async function getAllBanners(req, res) {
  const result = await bannerService.getAllBanners(req.query);
  return ResponseHelper.success(
    res,
    result.message,
    result.data,
    StatusCodes.OK,
    result.meta || {}
  );
}

async function updateBanner(req, res) {
  const payload = payloadFromRequest(req, { includeExistingImage: false });
  const result = await bannerService.updateBanner(req.params.id, payload);
  return ResponseHelper.success(res, result.message, result.data);
}

async function deleteBanner(req, res) {
  const result = await bannerService.deleteBanner(req.params.id);
  return ResponseHelper.success(res, result.message, result.data || {});
}

module.exports = {
  createBanner,
  getAllBanners,
  updateBanner,
  deleteBanner,
};
