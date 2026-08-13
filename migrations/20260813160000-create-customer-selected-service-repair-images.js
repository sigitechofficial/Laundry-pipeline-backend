'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'customerSelectedServiceRepairImages')) {
      return;
    }

    await queryInterface.createTable('customerSelectedServiceRepairImages', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      customerSelectedServiceId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'customerSelectedServices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      customerSelectedServiceLineId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'customerSelectedServiceLines', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      imageUrl: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Relative path under /Public (e.g. Public/repairImages/...)',
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      createdAt: { allowNull: false, type: Sequelize.DATE },
      updatedAt: { allowNull: false, type: Sequelize.DATE },
    });

    await queryInterface.addIndex(
      'customerSelectedServiceRepairImages',
      ['customerSelectedServiceId'],
      { name: 'cssri_selected_service_idx' }
    );
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'customerSelectedServiceRepairImages')) {
      await queryInterface.dropTable('customerSelectedServiceRepairImages');
    }
  },
};
