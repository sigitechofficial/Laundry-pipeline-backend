"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const zoneCatalogService = require("../../services/Admin/zoneCatalogService");
const { ValidationError } = require("../../middlewares/universalErrorHandler");

exports.getEffectiveCatalog = async (req, res) => {
  const zoneId = parseInt(req.params.zoneId, 10);
  if (!Number.isFinite(zoneId)) throw new ValidationError("zoneId is required");
  const data = await zoneCatalogService.getEffectiveCatalog(zoneId);
  return ResponseHelper.success(res, "Zone catalog", data);
};

exports.upsertOverride = async (req, res) => {
  const zoneId = parseInt(req.params.zoneId, 10);
  const { type } = req.body || {};
  if (type === "attach") {
    const data = await zoneCatalogService.upsertAttach(zoneId, req.body, {
      adminUserId: req.user?.id,
    });
    return ResponseHelper.success(res, "Attach override saved", data);
  }
  const data = await zoneCatalogService.upsertOverride(zoneId, type, req.body, {
    adminUserId: req.user?.id,
  });
  return ResponseHelper.success(res, "Override saved", data);
};

exports.resetOverride = async (req, res) => {
  const zoneId = parseInt(req.params.zoneId, 10);
  const {
    type,
    entityId,
    subCategoryId,
    addOnCategoryId,
    serviceId,
    preferenceTypeId,
  } = req.body || {};
  const data = await zoneCatalogService.resetOverride(zoneId, type, entityId, {
    subCategoryId,
    addOnCategoryId,
    serviceId,
    preferenceTypeId,
  });
  return ResponseHelper.success(res, "Override reset to master", data);
};

exports.copyOverrides = async (req, res) => {
  const toZoneId = parseInt(req.params.zoneId, 10);
  const fromZoneId = parseInt(req.body?.fromZoneId, 10);
  if (!Number.isFinite(toZoneId) || !Number.isFinite(fromZoneId)) {
    throw new ValidationError("fromZoneId and zoneId are required");
  }
  const replace = Boolean(req.body?.replace);
  const data = await zoneCatalogService.copyOverrides(fromZoneId, toZoneId, {
    replace,
  });
  return ResponseHelper.success(res, "Overrides copied", data);
};
