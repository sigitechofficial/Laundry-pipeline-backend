'use strict'
const { Model } = require('sequelize')
module.exports = (sequelize, DataTypes) => {
  class categories extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // relation with Model subCategories
      categories.hasMany(models.subCategories)
      models.subCategories.belongsTo(categories)

      // Realtion with Model Booking
      categories.hasMany(models.booking)
      models.booking.belongsTo(categories)

      // Relation with Model customerSelectedService
      categories.hasMany(models.customerSelectedService, {
        foreignKey: 'categoryId'
      })
      models.customerSelectedService.belongsTo(categories, {
        foreignKey: 'categoryId'
      })

      //Relation with Model serviceCategories
      categories.hasMany(models.serviceCategories)
      models.serviceCategories.belongsTo(categories)

      categories.belongsTo(models.service, {
        foreignKey: 'serviceId',
        as: 'service',
      })
      models.service.hasMany(categories, {
        foreignKey: 'serviceId',
        as: 'categories',
      })
    }
  }
  categories.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true
    },
    image:{
      type:DataTypes.STRING,
      allowNull:true
    },
    description:{
      type:DataTypes.STRING(300),
      allowNull:true,
      defaultValue:null
    },
    serviceId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'services',
        key: 'id',
      },
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Display order within a service (lower = first)',
    },
  }, {
    sequelize,
    modelName: 'categories',
    paranoid:true
  })
  return categories
}
