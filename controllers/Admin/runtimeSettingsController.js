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

/** GET /admin/runtimeSettings/shopCapacityOverrides — shops with their own slot capacity on. */
async function getShopCapacityOverrides(req, res) {
  const shopAssignmentPolicyService = require("../../services/Admin/shopAssignmentPolicyService");
  const [shops, allShopsEnabled] = await Promise.all([
    shopAssignmentPolicyService.listCapacityOverrides(),
    runtimeSettingsService.getBoolean("shopAcceptCapEnabled"),
  ]);
  return ResponseHelper.success(res, "Shops with their own slot capacity", {
    allShopsEnabled,
    shops: shops.map((s) => ({ ...s, inUse: allShopsEnabled })),
  });
}

/** GET /admin/runtimeSettings/whatsapp — what is set up, and the latest messages. */
async function getWhatsAppStatus(req, res) {
  const whatsappService = require("../../services/whatsappService");
  let recent = [];
  try {
    recent = await whatsappService.recentMessages(req.query?.limit || 25);
  } catch (err) {
    // Table missing until the migration has run.
    console.warn("[whatsapp] recent messages unavailable:", err.message);
  }
  return ResponseHelper.success(res, "WhatsApp messages", {
    ...whatsappService.configurationStatus(),
    recent,
  });
}

module.exports = {
  getRuntimeSettings,
  updateRuntimeSettings,
  getShopCapacityOverrides,
  getWhatsAppStatus,
};
