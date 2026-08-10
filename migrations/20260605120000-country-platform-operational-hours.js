"use strict";

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

const SHORT_NAME_TZ = {
  GB: "Europe/London",
  UK: "Europe/London",
  PK: "Asia/Karachi",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  US: "America/New_York",
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, "countries", "ianaTimeZone", {
      type: Sequelize.STRING(64),
      allowNull: true,
    });

    const [countryRows] = await queryInterface.sequelize.query(
      "SELECT id, shortName FROM countries"
    );
    for (const row of countryRows || []) {
      const sn = String(row.shortName || "").toUpperCase();
      const tz = SHORT_NAME_TZ[sn] || "Europe/London";
      await queryInterface.sequelize.query(
        "UPDATE countries SET ianaTimeZone = :tz WHERE id = :id",
        { replacements: { tz, id: row.id } }
      );
    }

    await addColumnIfMissing(
      queryInterface,
      "platformOperationalHours",
      "countryId",
      {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "countries", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      }
    );

    const [firstCountry] = await queryInterface.sequelize.query(
      "SELECT id FROM countries ORDER BY id ASC LIMIT 1"
    );
    const defaultCountryId = firstCountry?.[0]?.id;

    // Greenfield DBs may have zero countries — never invent FK id=1.
    if (defaultCountryId) {
      await queryInterface.sequelize.query(
        "UPDATE platformOperationalHours SET countryId = :countryId WHERE countryId IS NULL",
        { replacements: { countryId: defaultCountryId } }
      );
    }

    try {
      await queryInterface.removeConstraint(
        "platformOperationalHours",
        "dayOfWeek"
      );
    } catch (_) {
      try {
        await queryInterface.removeIndex(
          "platformOperationalHours",
          "dayOfWeek"
        );
      } catch (__) {
        // ignore
      }
    }

    if (defaultCountryId) {
      await queryInterface.changeColumn(
        "platformOperationalHours",
        "countryId",
        {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "countries", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        }
      );
    }

    // Unique (countryId, dayOfWeek) — skip if already present
    const [uq] = await queryInterface.sequelize.query(`
      SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'platformOperationalHours'
        AND CONSTRAINT_NAME = 'platform_operational_hours_country_day_unique'
      LIMIT 1
    `);
    if (!uq.length) {
      await queryInterface.addConstraint("platformOperationalHours", {
        fields: ["countryId", "dayOfWeek"],
        type: "unique",
        name: "platform_operational_hours_country_day_unique",
      });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeConstraint(
        "platformOperationalHours",
        "platform_operational_hours_country_day_unique"
      );
    } catch (_) {}
    await removeColumnIfExists(
      queryInterface,
      "platformOperationalHours",
      "countryId"
    );
    await removeColumnIfExists(queryInterface, "countries", "ianaTimeZone");
    try {
      await queryInterface.addConstraint("platformOperationalHours", {
        fields: ["dayOfWeek"],
        type: "unique",
        name: "dayOfWeek",
      });
    } catch (_) {}
  },
};
