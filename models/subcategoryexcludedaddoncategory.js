'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class subCategoryExcludedAddOnCategory extends Model {
    static associate(models) {
      subCategoryExcludedAddOnCategory.belongsTo(models.subCategories, {
        foreignKey: 'subCategoryId',
      });
      subCategoryExcludedAddOnCategory.belongsTo(models.addOnCategory, {
        foreignKey: 'addOnCategoryId',
      });
    }
  }

  subCategoryExcludedAddOnCategory.init(
    {
      subCategoryId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'subCategories', key: 'id' },
      },
      addOnCategoryId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'addOnCategories', key: 'id' },
      },
    },
    {
      sequelize,
      modelName: 'subCategoryExcludedAddOnCategory',
      tableName: 'subCategoryExcludedAddOnCategories',
    }
  );

  return subCategoryExcludedAddOnCategory;
};
