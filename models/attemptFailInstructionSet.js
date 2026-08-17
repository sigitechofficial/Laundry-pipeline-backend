'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class attemptFailInstructionSet extends Model {
    static associate(models) {
      attemptFailInstructionSet.hasMany(models.attemptFailInstruction, {
        foreignKey: 'setId',
        as: 'items',
      });
      if (models.zone) {
        attemptFailInstructionSet.belongsTo(models.zone, {
          foreignKey: 'zoneId',
          as: 'zone',
        });
      }
    }
  }

  attemptFailInstructionSet.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      scope: {
        type: DataTypes.ENUM('pickup', 'delivery'),
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      zoneId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
    },
    {
      sequelize,
      modelName: 'attemptFailInstructionSet',
      tableName: 'attempt_fail_instruction_sets',
    }
  );

  return attemptFailInstructionSet;
};
