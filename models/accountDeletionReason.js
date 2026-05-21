'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class accountDeletionReason extends Model {
    static associate() {}
  }

  accountDeletionReason.init(
    {
      label: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      isOther: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'accountDeletionReason',
      tableName: 'accountDeletionReasons',
    }
  );

  return accountDeletionReason;
};
