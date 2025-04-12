'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class onHoldOption extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      //Relation with Model onHoldCustomerOption
      onHoldOption.hasOne(models.onHoldCustomerOption, { foreignKey: 'onHoldOptionId' })
      models.onHoldCustomerOption.belongsTo(onHoldOption, { foreignKey: 'onHoldOptionId' })

      //Relation with Model OnHoldConfirmation
      onHoldOption.hasMany(models.OnHoldConfirmation,{as:'agentHoldId',foreignKey:'onHoldOptionId'})
      models.OnHoldConfirmation.belongsTo(onHoldOption,{as:'agentHoldId',foreignKey:'onHoldOptionId'})
    }
  }
  onHoldOption.init({
    option: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    sequelize,
    modelName: 'onHoldOption',
  });
  return onHoldOption;
};