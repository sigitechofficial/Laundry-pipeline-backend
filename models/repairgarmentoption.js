'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class repairGarmentOption extends Model {
    static associate() {}
  }

  repairGarmentOption.init(
    {
      repairGarmentId: { type: DataTypes.INTEGER, allowNull: false },
      repairOptionId: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      sequelize,
      modelName: 'repairGarmentOption',
      tableName: 'repairGarmentOptions',
    }
  );

  return repairGarmentOption;
};
