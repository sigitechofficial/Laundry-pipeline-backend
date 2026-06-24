'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class users extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {

      //Realtion with Address Model
      users.hasOne(models.addressDb)
      models.addressDb.belongsTo(users)
      
      //Realtion with Device token model
      users.hasMany(models.deviceToken)
      models.deviceToken.belongsTo(users)
      
      //Relation with Booking table as Customer
      users.hasMany(models.booking,{as:'customer',foreignKey:'customerId'})
      models.booking.belongsTo(users,{as:'customer',foreignKey:'customerId'})
      
      //Relation with Booking table as Driver
      users.hasMany(models.booking,{as:'driver',foreignKey:'driverId'})
      models.booking.belongsTo(users,{as:'driver',foreignKey:'driverId'})

      //Relation with booking Model as Delivery Driver
      users.hasMany(models.booking,{as:'deliveryDriver',foreignKey:'deliveryDriverId'})
      models.booking.belongsTo(users,{as:'deliveryDriver',foreignKey:'deliveryDriverId'})

      //Relation with tip table as Driver
      users.hasMany(models.tip,{as:'driverTip',foreignKey:'driverId'})
      models.tip.belongsTo(users,{as:'driverTip',foreignKey:'driverId'})

      // Relation with wallet model (belongsTo defined on wallet model)
      users.hasMany(models.wallet, { foreignKey: 'userId', as: 'walletEntries' })

      //realtion with model otp verification
      users.hasOne(models.otpVerification)
      models.otpVerification.belongsTo(users)

      //Relation with model device token
      users.hasMany(models.deviceToken)
      models.deviceToken.belongsTo(users)

      //Realtion with model cancel Booking
      users.hasMany(models.cancelBooking)
      models.cancelBooking.belongsTo(users)

      //Realtion with Driver Details Table
      users.hasMany(models.driverDetail,{as:'driverDetails',foreignKey:'userId'})
      models.driverDetail.belongsTo(users,{as:'driverDetails',foreignKey:'userId'})

      //Relation with model DriverInZones
      users.hasMany(models.driverInZones,{as:'driverInZone',foreignKey:'driverId'})
      models.driverInZones.belongsTo(users,{as:'driverInZone',foreignKey:'driverId'})

      //Relation with model AgentSelectServices
      users.hasMany(models.agentSelectServices,{as:'agentServices',foreignKey:'agentServiceId'})
      models.agentSelectServices.belongsTo(users,{as:'agentServices',foreignKey:'agentServiceId'})

      //Rekation with model bussinessInformation
      users.hasMany(models.bussinessInformation,{as:'agentInfo',foreignKey:'agentId'})
      models.bussinessInformation.belongsTo(users,{as:'agentInfo',foreignKey:'agentId'})

      //Relation with model proofOfDeliveries
      users.hasMany(models.proofOfDeliveries)
      models.proofOfDeliveries.belongsTo(users)

      //Relation with model bussinesInformation
      users.hasOne(models.bussinessInformation,{as:'businessInfo',foreignKey:'agentId'})
      models.bussinessInformation.belongsTo(users,{as:'businessInfo',foreignKey:'agentId'})
      
      //Relation with Model bussinessWorkingHours
      users.hasMany(models.bussinessWorkingHours,{foreignKey:'userId'})
      models.bussinessWorkingHours.belongsTo(users,{foreignKey:'userId'})

      //Relation with Zone table
      users.hasMany(models.zone,{as:'zoneAdmin',foreignKey:'zoneAdminId'})
      models.zone.belongsTo(users,{as:'zoneAdmin',foreignKey:'zoneAdminId'})


    }
  }
  users.init({
    firstName: {
      allowNull:true,
      type: DataTypes.STRING,
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull:true,
      unique:true,
      validate:{
        isEmail:true
      }
    },
    password: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    phoneNum: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    stripeCustomerId: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    dvToken: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    image: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    deletedAt: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    signedFrom: {
      type: DataTypes.STRING,
      allowNull:true,
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull:false,
      defaultValue:false
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull:true
    },
    driverType:{
      type:DataTypes.ENUM('Freelance Driver','laundary Shop Driver'),
      allowNull:true
    },
    employeeOff:{
      type:DataTypes.INTEGER,
      allowNull:true,
      defaultValue:null
    },
    countryCode:{
      type:DataTypes.STRING,
      allowNull:true
    },
    ianaTimeZone: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    agentApprovalStatus: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'approved',
    },
    rejectionReason: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    createdAt: {
      allowNull: false,
      type: DataTypes.DATE
    },
    updatedAt: {
      allowNull: false,
      type: DataTypes.DATE
    }
  }, {
    sequelize,
    modelName: 'users',
    paranoid: true, // Enable soft delete with deletedAt
  });
  return users;
};