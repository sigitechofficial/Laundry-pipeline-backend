'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDefinition = await queryInterface.describeTable('bussinessInformations');

    if (!tableDefinition.isConnectAccountConnected) {
      await queryInterface.addColumn('bussinessInformations', 'isConnectAccountConnected', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      });
    }

    if (!tableDefinition.connectAccountId) {
      await queryInterface.addColumn('bussinessInformations', 'connectAccountId', {
        type: Sequelize.STRING,
        allowNull: true
      });
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('bussinessInformations', 'isConnectAccountConnected');
    await queryInterface.removeColumn('bussinessInformations', 'connectAccountId');
  }
};

