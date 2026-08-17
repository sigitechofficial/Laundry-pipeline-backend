'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class attemptFailInstruction extends Model {
    static associate(models) {
      attemptFailInstruction.belongsTo(models.attemptFailInstructionSet, {
        foreignKey: 'setId',
        as: 'set',
      });
    }
  }

  attemptFailInstruction.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      setId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      body: {
        type: DataTypes.STRING(1000),
        allowNull: true,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      isEnabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      isRequired: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      sequelize,
      modelName: 'attemptFailInstruction',
      tableName: 'attempt_fail_instructions',
    }
  );

  return attemptFailInstruction;
};
