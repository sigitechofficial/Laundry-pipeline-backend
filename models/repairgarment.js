'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class repairGarment extends Model {
    static associate(models) {
      repairGarment.belongsToMany(models.repairOption, {
        through: models.repairGarmentOption,
        foreignKey: 'repairGarmentId',
        otherKey: 'repairOptionId',
        as: 'options',
      });
      repairGarment.hasMany(models.customerSelectedRepairItem, {
        foreignKey: 'repairGarmentId',
        as: 'selectedItems',
      });
    }
  }

  repairGarment.init(
    {
      name: { type: DataTypes.STRING, allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
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
      modelName: 'repairGarment',
      tableName: 'repairGarments',
      paranoid: true,
    }
  );

  return repairGarment;
};
