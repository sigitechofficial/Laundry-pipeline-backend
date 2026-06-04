"use strict";

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
    await queryInterface.addColumn("countries", "ianaTimeZone", {
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

    await queryInterface.addColumn("platformOperationalHours", "countryId", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "countries", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    });

    const [firstCountry] = await queryInterface.sequelize.query(
      "SELECT id FROM countries ORDER BY id ASC LIMIT 1"
    );
    const defaultCountryId = firstCountry?.[0]?.id ?? 1;

    await queryInterface.sequelize.query(
      "UPDATE platformOperationalHours SET countryId = :countryId WHERE countryId IS NULL",
      { replacements: { countryId: defaultCountryId } }
    );

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
        // MySQL may name the unique index differently; ignore if already gone
      }
    }

    await queryInterface.changeColumn("platformOperationalHours", "countryId", {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "countries", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    });

    await queryInterface.addConstraint("platformOperationalHours", {
      fields: ["countryId", "dayOfWeek"],
      type: "unique",
      name: "platform_operational_hours_country_day_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint(
      "platformOperationalHours",
      "platform_operational_hours_country_day_unique"
    );
    await queryInterface.removeColumn(
      "platformOperationalHours",
      "countryId"
    );
    await queryInterface.removeColumn("countries", "ianaTimeZone");
    await queryInterface.addConstraint("platformOperationalHours", {
      fields: ["dayOfWeek"],
      type: "unique",
      name: "dayOfWeek",
    });
  },
};
