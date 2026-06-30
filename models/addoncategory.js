'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class addOnCategory extends Model {
    static associate(models) {
      // A category groups many add-on services (e.g. "Blouse" → "Blouse Button Resew")
      addOnCategory.hasMany(models.addOnServices, {
        foreignKey: 'addOnCategoryId',
        as: 'addOnServices'
      });

      // A category can be linked to many sub-categories via a join table.
      addOnCategory.belongsToMany(models.subCategories, {
        through: models.subCategoryAddOnCategory,
        foreignKey: 'addOnCategoryId',
        otherKey: 'subCategoryId',
        as: 'subCategories'
      });
    }
  }

  addOnCategory.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    sequelize,
    modelName: 'addOnCategory',
    paranoid: true
  });

  return addOnCategory;
};
