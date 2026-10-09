'use strict';
const { Model } = require('sequelize');

/** Customer credit ledger (docs/CASHBACK_CREDIT_PLAN.md). One row per movement. */
module.exports = (sequelize, DataTypes) => {
  class customerCreditEntry extends Model {
    static associate(models) {
      customerCreditEntry.belongsTo(models.booking, { foreignKey: 'bookingId', as: 'booking' });
      customerCreditEntry.belongsTo(models.promotion, { foreignKey: 'promotionId', as: 'promotion' });
      customerCreditEntry.hasMany(models.customerCreditAllocation, { foreignKey: 'spendEntryId', as: 'allocations' });
    }
  }

  customerCreditEntry.init(
    {
      customerId: { type: DataTypes.INTEGER, allowNull: false },
      type: {
        type: DataTypes.ENUM('EARN', 'ADJUST', 'SPEND', 'REVERSE', 'RESTORE', 'EXPIRE'),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('POSTED', 'HELD', 'COMMITTED', 'RELEASED'),
        allowNull: false,
        defaultValue: 'POSTED',
      },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      remainingAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'GBP' },
      expiresAt: { type: DataTypes.DATE, allowNull: true },
      bookingId: { type: DataTypes.INTEGER, allowNull: true },
      promotionId: { type: DataTypes.INTEGER, allowNull: true },
      redemptionId: { type: DataTypes.INTEGER, allowNull: true },
      sourceEntryId: { type: DataTypes.INTEGER, allowNull: true },
      idempotencyKey: { type: DataTypes.STRING(120), allowNull: true, unique: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
      reason: { type: DataTypes.STRING(500), allowNull: true },
      actorId: { type: DataTypes.INTEGER, allowNull: true },
      actorType: { type: DataTypes.STRING(20), allowNull: true },
    },
    {
      sequelize,
      modelName: 'customerCreditEntry',
      tableName: 'customer_credit_entries',
    }
  );

  return customerCreditEntry;
};
