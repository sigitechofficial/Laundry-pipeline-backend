"use strict";

const ResponseHelper = require("../../utils/responseHelper");
const runtimeSettingsService = require("../../services/Admin/runtimeSettingsService");

async function getRuntimeSettings(req, res) {
  const data = await runtimeSettingsService.getAll();
  return ResponseHelper.success(res, "Runtime settings", data);
}

async function updateRuntimeSettings(req, res) {
  const data = await runtimeSettingsService.updateSettings(
    req.body || {},
    req.user?.id || null
  );
  return ResponseHelper.success(res, "Runtime settings updated", data);
}

module.exports = {
  getRuntimeSettings,
  updateRuntimeSettings,
};
