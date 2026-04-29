'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bookingPreferences', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      bookingId: {
        type: Sequelize.INTEGER
      },
      customerSelectedServiceId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
      },
      preferenceTypeId: {
        type: Sequelize.INTEGER
      },
      preferenceValueId: {
        type: Sequelize.INTEGER
      },
      parentPreferenceValueId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null
      },
      preferenceInstruction: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bookingPreferences');
  }
};