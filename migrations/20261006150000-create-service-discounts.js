'use strict';

const { tableExists } = require('../utils/migrationHelpers');

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface, 'serviceDiscounts')) return;

    await queryInterface.createTable('serviceDiscounts', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(120),
        allowNull: false,
        comment: 'Admin-visible label for this discount rule',
      },
      discountType: {
        type: Sequelize.ENUM('percentage', 'flat'),
        allowNull: false,
        defaultValue: 'flat',
      },
      discountValue: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        comment: '% value (0-100) for percentage; £ amount for flat',
      },
      maxDiscountCap: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null,
        comment: 'Maximum £ cap when discountType=percentage',
      },
      // What this discount applies to
      targetType: {
        type: Sequelize.ENUM('all', 'service', 'category', 'subCategory', 'addon'),
        allowNull: false,
        defaultValue: 'all',
        comment: 'Scope: all=everything, service=specific service tree, category=category tree, subCategory=specific item, addon=specific add-on',
      },
      targetId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
        comment: 'serviceId / categoryId / subCategoryId / addOnServiceId depending on targetType',
      },
      // Zone scope
      zoneMode: {
        type: Sequelize.ENUM('all', 'specific'),
        allowNull: false,
        defaultValue: 'all',
      },
      zoneIds: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: null,
        comment: 'Array of zone IDs when zoneMode=specific; null/[] = all zones',
      },
      // Validity window
      validFrom: {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      },
      validTo: {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('serviceDiscounts');
  },
};
