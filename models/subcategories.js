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
      subCategories.hasMany(models.customerSelectedService, {
        foreignKey: 'subCategoryId'
      })
      models.customerSelectedService.belongsTo(subCategories, {
        foreignKey: 'subCategoryId'
      })

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
    },
    description:{
      type:DataTypes.STRING,
      allowNull:true,
    },
    barCode:{
      type:DataTypes.STRING,
      allowNull:true
    },
    weightKg: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Weight in kg for weight-based services (e.g. 6 for 6kg). Null for item-based services.'
    }
  }, {
    sequelize,
    modelName: 'subCategories',
    paranoid:true
  });
  return subCategories;
};