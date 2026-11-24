'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class deviceToken extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  deviceToken.init({
    tokenId: {
      type:DataTypes.STRING,
    allowNull:true},
    status: {
      type:DataTypes.BOOLEAN,
      defaultValue:false},
    // App install the token belongs to (utils/appSession.js); NULL for legacy rows.
    deviceId: {
      type: DataTypes.STRING(36),
      allowNull: true,
    },
    // Firebase project that issued tokenId (utils/firebaseProjects.js); NULL = not known yet,
    // routed legacy-first and recorded on first successful send (utils/fcmRouting.js).
    firebaseProjectId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
  }, {
    sequelize,
    modelName: 'deviceToken',
    paranoid: true,
  });
  return deviceToken;
};