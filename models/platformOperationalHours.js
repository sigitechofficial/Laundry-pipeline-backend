"use strict";
const { Model } = require("sequelize");

module.exports = (sequelize, DataTypes) => {
  class platformOperationalHours extends Model {
    static associate(models) {
      platformOperationalHours.belongsTo(models.countries, {
        foreignKey: "countryId",
      });
    }
  }

  platformOperationalHours.init(
    {
      countryId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      dayOfWeek: {
        type: DataTypes.ENUM(
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday"
        ),
        allowNull: false,
      },
      openTime: {
        type: DataTypes.TIME,
        allowNull: true,
        defaultValue: "07:00:00",
      },
      closeTime: {
        type: DataTypes.TIME,
        allowNull: true,
        defaultValue: "20:00:00",
      },
      status: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      sequelize,
      modelName: "platformOperationalHours",
      tableName: "platformOperationalHours",
    }
  );

  return platformOperationalHours;
};
