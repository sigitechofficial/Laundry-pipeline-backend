'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class repairOption extends Model {
    static associate(models) {
      repairOption.belongsToMany(models.repairGarment, {
        through: models.repairGarmentOption,
        foreignKey: 'repairOptionId',
        otherKey: 'repairGarmentId',
        as: 'garments',
      });
      repairOption.hasMany(models.customerSelectedRepairItemOption, {
        foreignKey: 'repairOptionId',
        as: 'selectedOptions',
      });
    }
  }

  repairOption.init(
    {
      name: { type: DataTypes.STRING, allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
      price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      sequelize,
      modelName: 'repairOption',
      tableName: 'repairOptions',
      paranoid: true,
    }
  );

  return repairOption;
};
