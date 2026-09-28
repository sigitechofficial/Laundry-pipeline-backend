'use strict';

module.exports = (sequelize, DataTypes) => {
  const shopPrinter = sequelize.define(
    'shopPrinter',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      shopUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      ipAddress: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      port: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 9100,
      },
      paperWidthMm: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 76,
      },
      partialCut: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      shopDisplayName: {
        type: DataTypes.STRING(120),
        allowNull: true,
      },
    },
    {
      tableName: 'shop_printers',
      timestamps: true,
    }
  );

  shopPrinter.associate = (models) => {
    if (models.users) {
      shopPrinter.belongsTo(models.users, {
        foreignKey: 'shopUserId',
        as: 'shopUser',
      });
    }
  };

  return shopPrinter;
};
