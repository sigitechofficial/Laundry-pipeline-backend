'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bussinessInformations', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      shopName: {
        type: Sequelize.STRING,
        allowNull: false
      },
      matchProfileOptions: {
        type: Sequelize.ENUM('ALL IN HOUSE- Washing, Ironing and Dry cleaning all done by us',
          'OUTSOURCE DRY CLEANING- Washing and Drying handled in house',
          'OUTSOURCE ALL- We are just a shop front that outsources all of the processing',
          'Other'),
        allowNull: true,
      },
      otherText: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      isConnectAccountConnected: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      connectAccountId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true
      }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bussinessInformations');
  }
};