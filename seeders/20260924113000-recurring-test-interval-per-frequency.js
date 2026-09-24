"use strict";

/**
 * Idempotent: insert per-frequency recurring test-interval runtime settings
 * (and the shared fallback / test-mode toggle if still missing on older envs).
 * Safe to re-run — skips any settingKey that already exists.
 */

function envOr(key, fallback) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function isTruthyEnv(value) {
  return ["true", "1", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      "SELECT settingKey FROM platformRuntimeSettings"
    );
    const have = new Set((existing || []).map((r) => r.settingKey));
    const now = new Date();

    // Prefer the already-seeded shared interval as the per-frequency default
    // so existing QA setups keep the same timing after this lands.
    const sharedDefault = envOr("RECURRING_TEST_INTERVAL_MINUTES", "3");

    const rows = [
      {
        settingKey: "recurringTestModeEnabled",
        settingValue: isTruthyEnv(envOr("RECURRING_TEST_MODE_ENABLED", "false"))
          ? "true"
          : "false",
        valueType: "boolean",
        label: "Recurring test mode",
        description:
          "TEST ONLY. When on, each recurring frequency uses its own test-interval (minutes) instead of the real cadence. Turn OFF in production.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_TEST_MODE_ENABLED",
      },
      {
        settingKey: "recurringTestIntervalMinutes",
        settingValue: sharedDefault,
        valueType: "integer",
        label: "Recurring test interval — shared fallback (minutes)",
        description:
          "Fallback minutes used when a per-frequency test interval is unset.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_TEST_INTERVAL_MINUTES",
      },
      {
        settingKey: "recurringTestIntervalMinutesWeekly",
        settingValue: envOr(
          "RECURRING_TEST_INTERVAL_MINUTES_WEEKLY",
          sharedDefault
        ),
        valueType: "integer",
        label: "Test interval — Weekly (minutes)",
        description:
          "When test mode is on, Weekly plans regenerate after this many minutes.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_TEST_INTERVAL_MINUTES_WEEKLY",
      },
      {
        settingKey: "recurringTestIntervalMinutesEveryTwoWeeks",
        settingValue: envOr(
          "RECURRING_TEST_INTERVAL_MINUTES_EVERY_TWO_WEEKS",
          sharedDefault
        ),
        valueType: "integer",
        label: "Test interval — Every two weeks (minutes)",
        description:
          "When test mode is on, Every-two-weeks plans regenerate after this many minutes.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_TEST_INTERVAL_MINUTES_EVERY_TWO_WEEKS",
      },
      {
        settingKey: "recurringTestIntervalMinutesEveryFourWeeks",
        settingValue: envOr(
          "RECURRING_TEST_INTERVAL_MINUTES_EVERY_FOUR_WEEKS",
          sharedDefault
        ),
        valueType: "integer",
        label: "Test interval — Every four weeks (minutes)",
        description:
          "When test mode is on, Every-four-weeks plans regenerate after this many minutes.",
        settingGroup: "booking_assignment",
        envKey: "RECURRING_TEST_INTERVAL_MINUTES_EVERY_FOUR_WEEKS",
      },
    ]
      .filter((row) => !have.has(row.settingKey))
      .map((row) => ({ ...row, createdAt: now, updatedAt: now }));

    if (!rows.length) {
      console.log(
        "[seed] recurring test-interval per-frequency settings already present — skip"
      );
      return;
    }

    await queryInterface.bulkInsert("platformRuntimeSettings", rows);
    console.log(
      `[seed] inserted ${rows.length} recurring test-interval setting(s)`
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete("platformRuntimeSettings", {
      settingKey: [
        "recurringTestIntervalMinutesWeekly",
        "recurringTestIntervalMinutesEveryTwoWeeks",
        "recurringTestIntervalMinutesEveryFourWeeks",
      ],
    });
  },
};
