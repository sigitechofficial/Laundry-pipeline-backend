'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class bookingCollectionImage extends Model {
    static associate(models) {
      bookingCollectionImage.belongsTo(models.booking, {
        foreignKey: 'bookingId',
      });
    }
  }

  bookingCollectionImage.init(
    {
      bookingId: {
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
      modelName: 'bookingCollectionImage',
      tableName: 'bookingCollectionImages',
    }
  );

  return bookingCollectionImage;
};
