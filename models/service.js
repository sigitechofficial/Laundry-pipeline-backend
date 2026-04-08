'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class service extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with Model Booking
      service.hasMany(models.booking)
      models.booking.belongsTo(service)

      //Realtion with Model customerSelectedService
      service.hasMany(models.customerSelectedService, {
        foreignKey: 'serviceId'
      })
      models.customerSelectedService.belongsTo(service, {
        foreignKey: 'serviceId'
      })

      //Relation with Model AgentSelectServices
      service.hasOne(models.agentSelectServices)
      models.agentSelectServices.belongsTo(service)

      //Realtion with Model servicePreferences
      service.hasMany(models.servicePreferences)
      models.servicePreferences.belongsTo(service)

      //Relation with Model on Hold Conformations
      service.hasMany(models.OnHoldConfirmation)
      models.OnHoldConfirmation.belongsTo(service)

      //Relation with Model Categories
      service.hasMany(models.categories)
      models.categories.belongsTo(service)

      //Realtion with Model serviceCategories
      service.hasMany(models.serviceCategories)
      models.serviceCategories.belongsTo(service)

      //Relation with Model serviceWithPreferences
      service.hasMany(models.serviceWithPreferences)
      models.serviceWithPreferences.belongsTo(service)
    }
  }
  service.init({
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.STRING(300),
      allowNull: true
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: 1
    },
    image:{
      type:DataTypes.STRING,
      allowNull:true
    },
    timeRequired: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    pricingBasis: {
      type: DataTypes.ENUM('weight', 'item'),
      allowNull: true,
      defaultValue: 'item'
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
      comment: 'Controls display order — lower number appears first (1 = top)'
    }
  }, {
    sequelize,
    modelName: 'service',
    paranoid:true
  });
  return service;
};