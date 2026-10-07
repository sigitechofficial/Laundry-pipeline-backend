'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class serviceDiscount extends Model {
    static associate() {}
  }

  serviceDiscount.init(
    {
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      discountType: {
        type: DataTypes.ENUM('percentage', 'flat'),
        allowNull: false,
        defaultValue: 'flat',
      },
      discountValue: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      maxDiscountCap: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null,
      },
      targetType: {
        type: DataTypes.ENUM('all', 'service', 'category', 'subCategory', 'addon'),
        allowNull: false,
        defaultValue: 'all',
      },
      targetId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null,
        comment: 'Legacy single target; prefer targetIds for multi-select',
      },
      targetIds: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
        comment: 'Array of service/category/subCategory/addon IDs (same targetType)',
      },
      zoneMode: {
        type: DataTypes.ENUM('all', 'specific'),
        allowNull: false,
        defaultValue: 'all',
      },
      zoneIds: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      },
      validFrom: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
      },
      validTo: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null,
      },
    },
    {
      sequelize,
      modelName: 'serviceDiscount',
      tableName: 'serviceDiscounts',
    }
  );

  return serviceDiscount;
};
