'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class customerSelectedRepairItemOption extends Model {
    static associate(models) {
      customerSelectedRepairItemOption.belongsTo(
        models.customerSelectedRepairItem,
        {
          foreignKey: 'customerSelectedRepairItemId',
          as: 'repairItem',
        }
      );
      customerSelectedRepairItemOption.belongsTo(models.repairOption, {
        foreignKey: 'repairOptionId',
        as: 'option',
      });
    }
  }

  customerSelectedRepairItemOption.init(
    {
      customerSelectedRepairItemId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      repairOptionId: { type: DataTypes.INTEGER, allowNull: false },
      optionName: { type: DataTypes.STRING, allowNull: false },
      price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      sequelize,
      modelName: 'customerSelectedRepairItemOption',
      tableName: 'customerSelectedRepairItemOptions',
    }
  );

  return customerSelectedRepairItemOption;
};
