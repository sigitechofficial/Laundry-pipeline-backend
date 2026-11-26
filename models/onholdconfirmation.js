'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class OnHoldConfirmation extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  OnHoldConfirmation.init({
    onHoldImg: {
      type: DataTypes.STRING,
      allowNull: true
    },
    noOfItems: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true
    },
    customerResponse:{
      type:DataTypes.BOOLEAN,
      defaultValue:false
    },
    deleted:{
      type:DataTypes.BOOLEAN,
      defaultValue:false
    },
    responseConformation:{
      type:DataTypes.BOOLEAN,
      defaultValue:false,
    },
    customerNote: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "What the customer wrote when answering (kept apart from the shop's description)"
    },
    respondedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When the customer answered this item'
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When the shop finished the hold and the order went back to processing'
    }
  }, {
    sequelize,
    modelName: 'OnHoldConfirmation',
  });
  return OnHoldConfirmation;
};