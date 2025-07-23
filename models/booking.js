'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class booking extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //relation with model wallet
      booking.hasMany(models.wallet)
      models.wallet.belongsTo(booking)
      
      //Relation with model billingDetail
      booking.hasOne(models.billingDetails)
      models.billingDetails.belongsTo(booking)

      //Relation with model tip
      booking.hasMany(models.tip)
      models.tip.belongsTo(booking)

      //Relation with model bookingHistory
      booking.hasMany(models.bookingHistory)
      models.bookingHistory.belongsTo(booking)

      //Realtion with model cancel Booking
      booking.hasOne(models.cancelBooking)
      models.cancelBooking.belongsTo(booking)

      //Relation with model customerSelectedService
      booking.hasMany(models.customerSelectedService)
      models.customerSelectedService.belongsTo(booking)

      //Relation with onHoldConformation model
      booking.hasMany(models.OnHoldConfirmation)
      models.OnHoldConfirmation.belongsTo(booking)

      //Relation with model proofOfDeliveries
      booking.hasMany(models.proofOfDeliveries)
      models.proofOfDeliveries.belongsTo(booking)

      //Relation with servicePreferences Model
      booking.hasMany(models.servicePreferences)
      models.servicePreferences.belongsTo(booking)
    }
  }
  booking.init({
    orderTrackId: {
      type:DataTypes.STRING,
      allowNull:true
    },
    collectionDate: {type:DataTypes.DATE,
      allowNull:false
    },
    collectionTimeTo: {
      type:DataTypes.TIME,
      allowNull:false
    },
    collectionTimeFrom: {
      type:DataTypes.TIME,
      allowNull:false
    },
    driverInstructionOptions:{
      type:DataTypes.ENUM('Collect from me in person','Collect from Outside','Collect from reception/Porter'),
      allowNull:false,
    },
    driverInstructionOptions1:{
      type:DataTypes.ENUM('Deliver to me in person','Leave at the door','Deliver to the Reception/Porter')
    },
    driverInstruction: {
      type:DataTypes.STRING,
    allowNull:true
  },
    paymentConfirmed: {
      type:DataTypes.BOOLEAN,
    allowNull:true,
  defaultValue:false
},
    partialPayment: {
      type:DataTypes.BOOLEAN,
      allowNull:false,
      defaultValue:false
  },
    totalItems: {
      type:DataTypes.INTEGER,
      allowNull:true,
    },
    orderAmount: {
      type:DataTypes.FLOAT,
      allowNull:true,
    },
    subTotal:{
      type:DataTypes.FLOAT,
      allowNull:true,
    },
    frequency: {
      type:DataTypes.ENUM('Just Once','Weekly','Every two weeks','Every four weeks'),
      allowNull:false,
      defaultValue:'Just Once'
    },
    deliveryDate: {
      type:DataTypes.DATE,
    allowNull:false
  },
    deliveryTimeFrom: {
      type:DataTypes.TIME,
    allowNull:false
  },
  orderExpireTime:{
    type:DataTypes.TIME,
    allowNull:true,
  },
  deliveryTimeTo:{
    type:DataTypes.TIME,
    allowNull:false
  },
  onHoldReason:{
    type:DataTypes.ENUM('Missing or Damaged Items .Items lost or damaged, requiring customer verification.',
      'Special Instructions Pending. Waiting for customer confirmation on delicate fabrics, stains, or specific washing preferences.',
      'Damaged or Shrinking Risk . Items that may shrink, bleed color, or have pre-existing damage, requiring approval before proceeding.',
      'Incorrect Tagging or Sorting. Mislabeling or mixing up orders requiring manual sorting.',
      'Damage Liability Waiver Needed.sDelicate or high-risk items need the customer to sign a waiver before cleaning.',
      'Other'
    ),
    allowNull:true,
  },
  OnHoldOtherReason:{
    type:DataTypes.STRING(500),
    allowNull:true
  },
  paymentMethodId:{
    type:DataTypes.STRING,
    allowNull:true
  },
  paymentIntentId:{
    type:DataTypes.STRING,
    allowNull:true
  }
  }, {
    sequelize,
    modelName: 'booking',
  });
  return booking;
};