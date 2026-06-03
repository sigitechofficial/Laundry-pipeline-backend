"use strict";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("platformOperationalHours", {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      dayOfWeek: {
        type: Sequelize.ENUM(...DAYS),
        allowNull: false,
        unique: true,
      },
      openTime: {
        type: Sequelize.TIME,
        allowNull: true,
        defaultValue: "07:00:00",
      },
      closeTime: {
        type: Sequelize.TIME,
        allowNull: true,
        defaultValue: "20:00:00",
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    const now = new Date();
    await queryInterface.bulkInsert(
      "platformOperationalHours",
      DAYS.map((dayOfWeek, index) => ({
        dayOfWeek,
        openTime: "07:00:00",
        closeTime: "20:00:00",
        status: index < 6,
        createdAt: now,
        updatedAt: now,
      }))
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable("platformOperationalHours");
  },
};
