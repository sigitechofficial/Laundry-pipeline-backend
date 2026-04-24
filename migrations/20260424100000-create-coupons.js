'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('coupons', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      code: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true
      },
      description: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      discountType: {
        type: Sequelize.ENUM('percentage', 'flat'),
        allowNull: false,
        defaultValue: 'flat'
      },
      discountValue: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false
      },
      minOrderAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null
      },
      maxDiscountCap: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: null,
        comment: 'Max discount allowed in £ (used for percentage type to cap discount)'
      },
      usageLimit: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
        comment: 'Total global redemption limit; null = unlimited'
      },
      usedCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      perUserLimit: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'How many times a single user can use this coupon'
      },
      startDate: {
        type: Sequelize.DATEONLY,
        allowNull: true,
        defaultValue: null
      },
      expiryDate: {
        type: Sequelize.DATEONLY,
        allowNull: true,
        defaultValue: null
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('coupons');
  }
};
