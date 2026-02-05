'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class bussinessInformation extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with Model bussinessWorkingHours
      bussinessInformation.hasMany(models.bussinessWorkingHours, { foreignKey: 'bussinessInformationId' })
      models.bussinessWorkingHours.belongsTo(bussinessInformation, { foreignKey: 'bussinessInformationId' })

      //Realtion with Model machine Count
      bussinessInformation.hasMany(models.machineCount, { as: 'agentShopMachine', foreignKey: 'bussinessInformationId' })
      models.machineCount.belongsTo(bussinessInformation, { as: 'agentShopMachine', foreignKey: 'bussinessInformationId' })

      //Relation with Model with driverInZones
      bussinessInformation.hasMany(models.driverInZones, { as: 'laundaryDriver', foreignKey: 'laundaryShopId' })
      models.driverInZones.belongsTo(bussinessInformation, { as: 'laundaryDriver', foreignKey: 'laundaryShopId' })

      //Relation with Model with addressDb
      bussinessInformation.belongsTo(models.addressDb, { foreignKey: 'shopAddressId' })
      models.addressDb.hasMany(bussinessInformation, { foreignKey: 'shopAddressId' })
      
    }
  }
  bussinessInformation.init({
    shopName: {
      type: DataTypes.STRING,
      allowNull: false
    },
    matchProfileOptions: {
      type: DataTypes.ENUM('ALL IN HOUSE- Washing, Ironing and Dry cleaning all done by us',
        'OUTSOURCE DRY CLEANING- Washing and Drying handled in house',
        'OUTSOURCE ALL- We are just a shop front that outsources all of the processing',
        'Other'),
      allowNull: true,
    },
    otherText: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    isConnectAccountConnected: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    connectAccountId: {
      type: DataTypes.STRING,
      allowNull: true
    },
  }, {
    sequelize,
    modelName: 'bussinessInformation',
  });
  return bussinessInformation;
};