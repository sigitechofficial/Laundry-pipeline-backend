'use strict';

/**
 * Historically ran before bussinessInformations existed (ordering bug).
 * create-bussiness-information already includes these columns for greenfield.
 * Keep this migration idempotent for older DBs that still need the columns.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const hasTable = tables.some(
      (t) => String(t).toLowerCase() === 'bussinessinformations'
    );
    if (!hasTable) {
      return;
    }

    const tableDefinition = await queryInterface.describeTable(
      'bussinessInformations'
    );

    if (!tableDefinition.isConnectAccountConnected) {
      await queryInterface.addColumn(
        'bussinessInformations',
        'isConnectAccountConnected',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        }
      );
    }

    if (!tableDefinition.connectAccountId) {
      await queryInterface.addColumn(
        'bussinessInformations',
        'connectAccountId',
        {
          type: Sequelize.STRING,
          allowNull: true,
        }
      );
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const hasTable = tables.some(
      (t) => String(t).toLowerCase() === 'bussinessinformations'
    );
    if (!hasTable) return;
    const tableDefinition = await queryInterface.describeTable(
      'bussinessInformations'
    );
    if (tableDefinition.isConnectAccountConnected) {
      await queryInterface.removeColumn(
        'bussinessInformations',
        'isConnectAccountConnected'
      );
    }
    if (tableDefinition.connectAccountId) {
      await queryInterface.removeColumn(
        'bussinessInformations',
        'connectAccountId'
      );
    }
  },
};
