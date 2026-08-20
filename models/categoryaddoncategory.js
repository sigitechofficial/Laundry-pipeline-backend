'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class categoryAddOnCategory extends Model {
    static associate(models) {
      categoryAddOnCategory.belongsTo(models.categories, {
        foreignKey: 'categoryId',
      });
      categoryAddOnCategory.belongsTo(models.addOnCategory, {
        foreignKey: 'addOnCategoryId',
      });
    }
  }

  categoryAddOnCategory.init(
    {
      categoryId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'categories', key: 'id' },
      },
      addOnCategoryId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'addOnCategories', key: 'id' },
      },
    },
    {
      sequelize,
      modelName: 'categoryAddOnCategory',
      tableName: 'categoryAddOnCategories',
    }
  );

  return categoryAddOnCategory;
};
