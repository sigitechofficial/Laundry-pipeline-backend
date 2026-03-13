'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('vehicleTypes', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      title: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      image: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      status: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      baseRate: {
        type: Sequelize.FLOAT(8,2),
        defaultValue: '0.00',
      },
      perUnitRate: {
        type: Sequelize.FLOAT(8,2),
        defaultValue: '0.00',
      },
      perRideCharge: {
        type: Sequelize.FLOAT(8,2),
        defaultValue: '0.00',
      },
      weightCapacity: {
        type: Sequelize.FLOAT(8,2),
        defaultValue: '0.00',
      },
      volumeCapacity: {
        type: Sequelize.FLOAT(8,2),
        defaultValue: '0.00',
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
    await queryInterface.dropTable('vehicleTypes');
  }
};