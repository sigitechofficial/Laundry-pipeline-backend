'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class reason extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with cancelBooking Model
      reason.hasOne(models.cancelBooking)
      models.cancelBooking.belongsTo(reason)
    }
  }
  reason.init({
    cancelReason: {
      type:DataTypes.STRING,
      allowNull:false,
  }
  }, {
    sequelize,
    modelName: 'reason',
  });
  return reason;
};