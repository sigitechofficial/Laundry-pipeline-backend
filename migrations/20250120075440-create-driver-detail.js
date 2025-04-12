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
        type: Sequelize.BOOLEAN
      },
      licIssueDate: {
        type: Sequelize.DATEONLY
      },
      licExpiryDate: {
        type: Sequelize.DATEONLY
      },
      licFrontImage: {
        type: Sequelize.STRING
      },
      licBackImage: {
        type: Sequelize.STRING
      },
      vehicleName: {
        type: Sequelize.STRING
      },
      vehicleModel: {
        type: Sequelize.STRING
      },
      vehicleYear: {
        type: Sequelize.STRING
      },
      vehicleColour: {
        type: Sequelize.STRING
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