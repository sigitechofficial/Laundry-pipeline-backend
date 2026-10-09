'use strict';
const { Model } = require('sequelize');

/** Which credit lots a SPEND used, so a released hold goes back to the same lots. */
module.exports = (sequelize, DataTypes) => {
  class customerCreditAllocation extends Model {
    static associate(models) {
      customerCreditAllocation.belongsTo(models.customerCreditEntry, { foreignKey: 'spendEntryId', as: 'spend' });
      customerCreditAllocation.belongsTo(models.customerCreditEntry, { foreignKey: 'lotEntryId', as: 'lot' });
    }
  }

  customerCreditAllocation.init(
    {
      spendEntryId: { type: DataTypes.INTEGER, allowNull: false },
      lotEntryId: { type: DataTypes.INTEGER, allowNull: false },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    },
    {
      sequelize,
      modelName: 'customerCreditAllocation',
      tableName: 'customer_credit_allocations',
      updatedAt: false,
    }
  );

  return customerCreditAllocation;
};
