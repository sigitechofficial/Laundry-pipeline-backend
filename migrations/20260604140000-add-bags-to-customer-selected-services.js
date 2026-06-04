"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("customerSelectedServices");
    if (!table.bags) {
      await queryInterface.addColumn("customerSelectedServices", "bags", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("customerSelectedServices");
    if (table.bags) {
      await queryInterface.removeColumn("customerSelectedServices", "bags");
    }
  },
};
