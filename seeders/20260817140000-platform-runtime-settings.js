"use strict";

function isTruthyEnv(value) {
  return ["true", "1", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function envOr(key, fallback) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      "SELECT settingKey FROM platformRuntimeSettings"
    );
    const have = new Set((existing || []).map((r) => r.settingKey));
    const now = new Date();

    const rows = [
      {
        settingKey: "geofenceBypassEnabled",
        settingValue: isTruthyEnv(process.env.GEOFENCE_BYPASS_ENABLED) ? "true" : "false",
        valueType: "boolean",
        label: "Bypass driver geofence",
        description:
          "When on, Arrived / Fail / unattended skip the distance check. QA only — turn off on live.",
        settingGroup: "geofence",
        envKey: "GEOFENCE_BYPASS_ENABLED",
      },
      {
        settingKey: "invoiceAutoChargeEnabled",
        settingValue: isTruthyEnv(envOr("INVOICE_AUTO_CHARGE_ENABLED", "true"))
          ? "true"
          : "false",
        valueType: "boolean",
        label: "Invoice auto-charge",
        description:
          "After invoice finalize, charge the card balance automatically. Off = no new schedules and the worker skips due charges.",
        settingGroup: "invoice",
        envKey: "INVOICE_AUTO_CHARGE_ENABLED",
      },
      {
        settingKey: "invoiceAutoChargeDelayMs",
        settingValue: envOr("INVOICE_AUTO_CHARGE_DELAY_MS", String(2 * 60 * 60 * 1000)),
        valueType: "integer",
        label: "Auto-charge delay (ms)",
        description: "Wait after invoice finalize before the first off-session charge.",
        settingGroup: "invoice",
        envKey: "INVOICE_AUTO_CHARGE_DELAY_MS",
      },
      {
        settingKey: "invoiceAutoChargeJobIntervalMs",
        settingValue: envOr("INVOICE_AUTO_CHARGE_JOB_INTERVAL_MS", "60000"),
        valueType: "integer",
        label: "Worker poll interval (ms)",
        description: "How often the auto-charge worker looks for due bookings.",
        settingGroup: "invoice",
        envKey: "INVOICE_AUTO_CHARGE_JOB_INTERVAL_MS",
      },
      {
        settingKey: "invoiceAutoChargeMaxAttempts",
        settingValue: envOr("INVOICE_AUTO_CHARGE_MAX_ATTEMPTS", "3"),
        valueType: "integer",
        label: "Max scheduled attempts",
        description: "Soft retries for recoverable card declines before waiting on admin.",
        settingGroup: "invoice",
        envKey: "INVOICE_AUTO_CHARGE_MAX_ATTEMPTS",
      },
      {
        settingKey: "invoiceAutoChargeRetryGapMs",
        settingValue: envOr("INVOICE_AUTO_CHARGE_RETRY_GAP_MS", String(30 * 60 * 1000)),
        valueType: "integer",
        label: "Retry gap (ms)",
        description: "Wait between recoverable auto-charge retries.",
        settingGroup: "invoice",
        envKey: "INVOICE_AUTO_CHARGE_RETRY_GAP_MS",
      },
      {
        settingKey: "recurringAutoCreateEnabled",
        settingValue: isTruthyEnv(envOr("RECURRING_AUTO_CREATE_ENABLED", "true"))
          ? "true"
          : "false",
        valueType: "boolean",
        label: "Recurring auto-create",
        description:
          "Auto-generate the next booking when a recurring order is delivered.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_AUTO_CREATE_ENABLED",
      },
      {
        settingKey: "recurringMaxFailuresBeforePause",
        settingValue: envOr("RECURRING_MAX_FAILURES_BEFORE_PAUSE", "3"),
        valueType: "integer",
        label: "Recurring max generation failures",
        description:
          "Pause recurring plans after this many consecutive auto-generation failures.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_MAX_FAILURES_BEFORE_PAUSE",
      },
    ]
      .filter((row) => !have.has(row.settingKey))
      .map((row) => ({ ...row, createdAt: now, updatedAt: now }));

    if (!rows.length) {
      console.log("[seed] platformRuntimeSettings already present — skip");
      return;
    }

    await queryInterface.bulkInsert("platformRuntimeSettings", rows);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete("platformRuntimeSettings", {
      settingKey: [
        "geofenceBypassEnabled",
        "invoiceAutoChargeEnabled",
        "invoiceAutoChargeDelayMs",
        "invoiceAutoChargeJobIntervalMs",
        "invoiceAutoChargeMaxAttempts",
        "invoiceAutoChargeRetryGapMs",
        "recurringAutoCreateEnabled",
        "recurringMaxFailuresBeforePause",
      ],
    });
  },
};
