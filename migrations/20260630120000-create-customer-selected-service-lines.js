'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('../lib/migrationHelpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Line table: one row per split line within a selected service.
    const tables = await queryInterface.showAllTables();
    const normalized = tables.map((t) => (typeof t === 'string' ? t : t.tableName));

    if (!normalized.includes('customerSelectedServiceLines')) {
      await queryInterface.createTable('customerSelectedServiceLines', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        customerSelectedServiceId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'customerSelectedServices', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        lineNum: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1
        },
        items: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE }
      });

      await queryInterface.addIndex(
        'customerSelectedServiceLines',
        ['customerSelectedServiceId'],
        { name: 'cssl_selected_service_idx' }
      );
    }

    // 2. Add-on row gets a link to its line + per-add-on instructions.
    const addOnCols = await queryInterface.describeTable('customerSelectedServiceAddOns');

    if (!addOnCols.customerSelectedServiceLineId) {
      // No inline references — MySQL would generate an identifier > 64 chars.
      await addColumnIfMissing(
        queryInterface,
        'customerSelectedServiceAddOns',
        'customerSelectedServiceLineId',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
        }
      );
      try {
        await queryInterface.addConstraint('customerSelectedServiceAddOns', {
          fields: ['customerSelectedServiceLineId'],
          type: 'foreign key',
          name: 'cssao_line_id_fkey',
          references: {
            table: 'customerSelectedServiceLines',
            field: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        });
      } catch (_) {
        // constraint may already exist on older DBs
      }
    }

    if (!addOnCols.instructions) {
      await addColumnIfMissing(queryInterface, 'customerSelectedServiceAddOns', 'instructions', {
        type: Sequelize.TEXT,
        allowNull: true
      });
    }
  },

  async down(queryInterface) {
    const addOnCols = await queryInterface.describeTable('customerSelectedServiceAddOns');
    if (addOnCols.customerSelectedServiceLineId) {
      await removeColumnIfExists(queryInterface, 'customerSelectedServiceAddOns',
        'customerSelectedServiceLineId'
      );
    }
    if (addOnCols.instructions) {
      await removeColumnIfExists(queryInterface, 'customerSelectedServiceAddOns', 'instructions');
    }
    await queryInterface.dropTable('customerSelectedServiceLines');
  }
};
