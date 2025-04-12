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
      service.hasMany(models.customerSelectedService)
      models.customerSelectedService.belongsTo(service)

      //Relation with Model AgentSelectServices
      service.hasOne(models.agentSelectServices)
      models.agentSelectServices.belongsTo(service)

      //Realtion with Model servicePreferences
      service.hasMany(models.servicePreferences)
      models.servicePreferences.belongsTo(service)

      //Relation with Model on Hold Conformations
      service.hasMany(models.OnHoldConfirmation)
      models.OnHoldConfirmation.belongsTo(service)
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
    timeRequired: {
      type: DataTypes.STRING(50),
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'service',
  });
  return service;
};