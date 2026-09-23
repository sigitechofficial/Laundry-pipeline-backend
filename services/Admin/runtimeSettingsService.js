"use strict";

const { platformRuntimeSetting } = require("../../models");
const { ValidationError } = require("../../middlewares/universalErrorHandler");

const CACHE_TTL_MS = 10 * 1000;

const DEFINITIONS = {
  geofenceBypassEnabled: {
    type: "boolean",
    label: "Bypass driver geofence",
    description:
      "When on, Arrived / Fail / unattended skip the distance check. QA only — turn off on live.",
    group: "geofence",
    envKey: "GEOFENCE_BYPASS_ENABLED",
    defaultValue: false,
  },
  invoiceAutoChargeEnabled: {
    type: "boolean",
    label: "Invoice auto-charge",
    description:
      "After invoice finalize, charge the card balance automatically. Off = no new schedules and the worker skips due charges.",
    group: "invoice",
    envKey: "INVOICE_AUTO_CHARGE_ENABLED",
    defaultValue: true,
  },
  invoiceAutoChargeDelayMs: {
    type: "integer",
    label: "Auto-charge delay (ms)",
    description: "Wait after invoice finalize before the first off-session charge.",
    group: "invoice",
    envKey: "INVOICE_AUTO_CHARGE_DELAY_MS",
    defaultValue: 2 * 60 * 60 * 1000,
    min: 0,
    max: 24 * 60 * 60 * 1000,
  },
  invoiceAutoChargeJobIntervalMs: {
    type: "integer",
    label: "Worker poll interval (ms)",
    description: "How often the auto-charge worker looks for due bookings.",
    group: "invoice",
    envKey: "INVOICE_AUTO_CHARGE_JOB_INTERVAL_MS",
    defaultValue: 60 * 1000,
    min: 10 * 1000,
    max: 30 * 60 * 1000,
  },
  invoiceAutoChargeMaxAttempts: {
    type: "integer",
    label: "Max scheduled attempts",
    description: "Soft retries for recoverable card declines before waiting on admin.",
    group: "invoice",
    envKey: "INVOICE_AUTO_CHARGE_MAX_ATTEMPTS",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  invoiceAutoChargeRetryGapMs: {
    type: "integer",
    label: "Retry gap (ms)",
    description: "Wait between recoverable auto-charge retries.",
    group: "invoice",
    envKey: "INVOICE_AUTO_CHARGE_RETRY_GAP_MS",
    defaultValue: 30 * 60 * 1000,
    min: 0,
    max: 24 * 60 * 60 * 1000,
  },
  preferredShopEnabled: {
    type: "boolean",
    label: "Preferred shop head-start",
    description:
      "When on, new bookings go first to the shop that last completed an order for that customer. If the shop does not accept within the window, the booking is broadcast to all shops.",
    group: "booking_assignment",
    envKey: "PREFERRED_SHOP_ENABLED",
    defaultValue: true,
  },
  preferredShopWindowMinutes: {
    type: "integer",
    label: "Preferred shop window (minutes)",
    description:
      "How long (minutes) the preferred shop has exclusive access before the booking broadcasts to everyone.",
    group: "booking_assignment",
    envKey: "PREFERRED_SHOP_WINDOW_MINUTES",
    defaultValue: 10,
    min: 1,
    max: 60,
  },
  recurringAutoCreateEnabled: {
    type: "boolean",
    label: "Recurring auto-create",
    description:
      "When on, non-'Just Once' bookings auto-generate the next cycle after delivery completion without customer confirmation.",
    group: "booking_assignment",
    envKey: "RECURRING_AUTO_CREATE_ENABLED",
    defaultValue: true,
  },
  zoneCatalogOverridesEnabled: {
    type: "boolean",
    label: "Zone catalog overlays",
    description:
      "When on, browse and charge use per-zone price overlays. Hidden services are always omitted for that zone, even when this is off.",
    group: "catalog",
    envKey: "ZONE_CATALOG_OVERRIDES",
    defaultValue: false,
  },
  recurringMaxFailuresBeforePause: {
    type: "integer",
    label: "Recurring max generation failures",
    description:
      "Auto-pause recurring plans once generation fails this many consecutive times.",
    group: "booking_assignment",
    envKey: "RECURRING_MAX_FAILURES_BEFORE_PAUSE",
    defaultValue: 3,
    min: 1,
    max: 10,
  },
  recurringTestModeEnabled: {
    type: "boolean",
    label: "Recurring test mode",
    description:
      "TEST ONLY. When on, every recurring order regenerates after 'Recurring test interval' minutes instead of its real weekly/2-weekly/4-weekly cadence, so the cycle can be verified in minutes. Turn OFF in production.",
    group: "booking_assignment",
    envKey: "RECURRING_TEST_MODE_ENABLED",
    defaultValue: false,
  },
  recurringTestIntervalMinutes: {
    type: "integer",
    label: "Recurring test interval (minutes)",
    description:
      "When 'Recurring test mode' is on, generate the next cycle this many minutes after the previous order (e.g. 3 = next order in 3 minutes).",
    group: "booking_assignment",
    envKey: "RECURRING_TEST_INTERVAL_MINUTES",
    defaultValue: 3,
    min: 1,
    max: 43200,
  },
};

let cache = { at: 0, byKey: null };

function isTruthy(value) {
  return ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseEnvFallback(def) {
  const raw = process.env[def.envKey];
  if (raw == null || String(raw).trim() === "") return def.defaultValue;
  if (def.type === "boolean") return isTruthy(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : def.defaultValue;
}

function coerceStored(def, raw) {
  if (def.type === "boolean") return isTruthy(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : def.defaultValue;
}

function serializeValue(def, value) {
  if (def.type === "boolean") return value ? "true" : "false";
  return String(value);
}

function invalidateCache() {
  cache = { at: 0, byKey: null };
}

async function loadRows() {
  if (cache.byKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.byKey;
  }
  try {
    const rows = await platformRuntimeSetting.findAll();
    const byKey = {};
    for (const row of rows) {
      byKey[row.settingKey] = row;
    }
    cache = { at: Date.now(), byKey };
    return byKey;
  } catch (err) {
    console.warn(
      "[runtimeSettings] table unavailable — using env fallbacks:",
      err.message
    );
    cache = { at: Date.now(), byKey: {} };
    return {};
  }
}

async function ensureDefaults() {
  const byKey = await loadRows();
  const missing = Object.keys(DEFINITIONS).filter((key) => !byKey[key]);
  if (!missing.length) return byKey;

  const now = new Date();
  try {
    await platformRuntimeSetting.bulkCreate(
      missing.map((settingKey) => {
        const def = DEFINITIONS[settingKey];
        const value = parseEnvFallback(def);
        return {
          settingKey,
          settingValue: serializeValue(def, value),
          valueType: def.type,
          label: def.label,
          description: def.description,
          settingGroup: def.group,
          envKey: def.envKey,
          createdAt: now,
          updatedAt: now,
        };
      })
    );
  } catch (err) {
    console.warn("[runtimeSettings] ensureDefaults failed:", err.message);
  }
  invalidateCache();
  return loadRows();
}

async function getValue(settingKey) {
  const def = DEFINITIONS[settingKey];
  if (!def) return null;
  const byKey = await loadRows();
  const row = byKey[settingKey];
  if (!row) return parseEnvFallback(def);
  return coerceStored(def, row.settingValue);
}

async function getBoolean(settingKey) {
  return Boolean(await getValue(settingKey));
}

async function getInteger(settingKey) {
  const n = Number(await getValue(settingKey));
  const def = DEFINITIONS[settingKey];
  return Number.isFinite(n) ? n : def?.defaultValue ?? 0;
}

function envSnapshot(def) {
  const raw = process.env[def.envKey];
  if (raw == null || String(raw).trim() === "") return null;
  return def.type === "boolean" ? isTruthy(raw) : Number(raw);
}

async function getAll() {
  const byKey = await ensureDefaults();
  const settings = {};
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    const row = byKey[key];
    const value = row ? coerceStored(def, row.settingValue) : parseEnvFallback(def);
    settings[key] = {
      key,
      value,
      type: def.type,
      label: def.label,
      description: def.description,
      group: def.group,
      envKey: def.envKey,
      envValue: envSnapshot(def),
      source: row ? "database" : "env",
      updatedAt: row?.updatedAt || null,
      updatedBy: row?.updatedBy || null,
    };
  }
  return { settings };
}

function parseIncoming(def, raw) {
  if (def.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === 1 || raw === 0) return raw === 1;
    if (typeof raw === "string") return isTruthy(raw);
    throw new ValidationError(`${def.label} must be true or false`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValidationError(`${def.label} must be a whole number`);
  }
  if (def.min != null && n < def.min) {
    throw new ValidationError(`${def.label} must be at least ${def.min}`);
  }
  if (def.max != null && n > def.max) {
    throw new ValidationError(`${def.label} must be at most ${def.max}`);
  }
  return n;
}

async function updateSettings(patch = {}, updatedBy = null) {
  if (!patch || typeof patch !== "object") {
    throw new ValidationError("settings payload is required");
  }

  const updates = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    const def = DEFINITIONS[key];
    if (!def) {
      throw new ValidationError(`Unknown setting: ${key}`);
    }
    updates[key] = parseIncoming(def, raw);
  }
  if (!Object.keys(updates).length) {
    throw new ValidationError("No recognized settings to update");
  }

  await ensureDefaults();

  for (const [settingKey, value] of Object.entries(updates)) {
    const def = DEFINITIONS[settingKey];
    const [row] = await platformRuntimeSetting.findOrCreate({
      where: { settingKey },
      defaults: {
        settingKey,
        settingValue: serializeValue(def, value),
        valueType: def.type,
        label: def.label,
        description: def.description,
        settingGroup: def.group,
        envKey: def.envKey,
        updatedBy,
      },
    });
    await row.update({
      settingValue: serializeValue(def, value),
      valueType: def.type,
      label: def.label,
      description: def.description,
      settingGroup: def.group,
      envKey: def.envKey,
      updatedBy,
    });
  }

  invalidateCache();

  if (
    updates.invoiceAutoChargeEnabled !== undefined ||
    updates.invoiceAutoChargeJobIntervalMs !== undefined
  ) {
    try {
      const invoiceAutoChargeService = require("../Agent/invoiceAutoChargeService");
      if (typeof invoiceAutoChargeService.restartInvoiceAutoChargeJob === "function") {
        await invoiceAutoChargeService.restartInvoiceAutoChargeJob();
      }
    } catch (err) {
      console.warn("[runtimeSettings] could not restart auto-charge job:", err.message);
    }
  }

  return getAll();
}

module.exports = {
  DEFINITIONS,
  getAll,
  getValue,
  getBoolean,
  getInteger,
  updateSettings,
  ensureDefaults,
  invalidateCache,
};
