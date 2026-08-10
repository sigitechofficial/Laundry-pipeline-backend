'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class addOnServices extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      addOnServices.hasMany(models.customerSelectedServiceAddOn, {
        foreignKey: 'addOnServiceId',
        as: 'selectedServiceAddOns'
      });

      // Each add-on service may belong to a category (e.g. "Blouse")
      addOnServices.belongsTo(models.addOnCategory, {
        foreignKey: 'addOnCategoryId',
        as: 'category'
      });
    }
  }
  addOnServices.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    },
    addOnCategoryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'addOnCategories',
        key: 'id'
      }
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order within an add-on category (lower = first)',
    }
  }, {
    sequelize,
    modelName: 'addOnServices',
    paranoid: true
  });
  return addOnServices;
};