'use strict';

const path = require('path');
const bannerService = require('../../services/Admin/bannerService');
const ResponseHelper = require('../../utils/responseHelper');
const { StatusCodes } = require('http-status-codes');

async function createBanner(req, res) {
  // Expect multipart/form-data with fields + optional file "image"
  let bannerImage = req.body.bannerImage || null;

  if (req.file) {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return ResponseHelper.validationError(res, 'Only jpg, png, and webp images are allowed');
    }
    if (req.file.size > 5 * 1024 * 1024) {
      return ResponseHelper.validationError(res, 'Image must be 5MB or smaller');
    }

    // Store relative path for serving via /Public static route
    bannerImage = req.file.path.replace(/\\/g, '/').replace(/^\.?\//, '');
  }

  const payload = {
    ...req.body,
    bannerImage,
  };

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
  const result = await bannerService.updateBanner(req.params.id, req.body);
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
