'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class subCategories extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with Model Booking
      subCategories.hasMany(models.booking)
      models.booking.belongsTo(subCategories)

      //Relation with Model customerSelectedService
      subCategories.hasMany(models.customerSelectedService)
      models.customerSelectedService.belongsTo(subCategories)

      //Relation with Model on Hold Conformations
      subCategories.hasMany(models.OnHoldConfirmation)
      models.OnHoldConfirmation.belongsTo(subCategories)
    }
  }
  subCategories.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    price: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'subCategories',
  });
  return subCategories;
};