'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class subCategoryAddOnCategory extends Model {
    static associate(models) {
      subCategoryAddOnCategory.belongsTo(models.subCategories, {
        foreignKey: 'subCategoryId'
      });
      subCategoryAddOnCategory.belongsTo(models.addOnCategory, {
        foreignKey: 'addOnCategoryId'
      });
    }
  }

  subCategoryAddOnCategory.init({
    subCategoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'subCategories', key: 'id' }
    },
    addOnCategoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'addOnCategories', key: 'id' }
    }
  }, {
    sequelize,
    modelName: 'subCategoryAddOnCategory',
    tableName: 'subCategoryAddOnCategories'
  });

  return subCategoryAddOnCategory;
};
