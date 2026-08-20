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

      // Sub-categories that explicitly opt out of inheriting this add-on category.
      addOnCategory.belongsToMany(models.subCategories, {
        through: models.subCategoryExcludedAddOnCategory,
        foreignKey: 'addOnCategoryId',
        otherKey: 'subCategoryId',
        as: 'excludedSubCategories'
      });

      // Catalog categories that inherit this add-on category for all items.
      addOnCategory.belongsToMany(models.categories, {
        through: models.categoryAddOnCategory,
        foreignKey: 'addOnCategoryId',
        otherKey: 'categoryId',
        as: 'catalogCategories'
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
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order of add-on categories (lower = first)',
    }
  }, {
    sequelize,
    modelName: 'addOnCategory',
    paranoid: true
  });

  return addOnCategory;
};
