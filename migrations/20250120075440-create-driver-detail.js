'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('driverDetails', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      approvedByAdmin: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      licIssueDate: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      licExpiryDate: {
        type: Sequelize.DATEONLY,
        allowNull: true,
      },
      licFrontImage: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      licBackImage: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      vehicleName: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      vehicleModel: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      vehicleYear: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      vehicleColour: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
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
    await queryInterface.dropTable('driverDetails');
  }
};