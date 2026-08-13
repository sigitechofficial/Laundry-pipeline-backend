'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerSelectedRepairItemImage extends Model {
    static associate(models) {
      customerSelectedRepairItemImage.belongsTo(
        models.customerSelectedRepairItem,
        {
          foreignKey: 'customerSelectedRepairItemId',
          as: 'repairItem',
        }
      );
    }
  }

  customerSelectedRepairItemImage.init(
    {
      customerSelectedRepairItemId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      imageUrl: { type: DataTypes.STRING, allowNull: false },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
    },
    {
      sequelize,
      modelName: 'customerSelectedRepairItemImage',
      tableName: 'customerSelectedRepairItemImages',
    }
  );

  return customerSelectedRepairItemImage;
};
