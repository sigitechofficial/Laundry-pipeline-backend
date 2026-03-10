'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billingDetails', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      bookingId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'bookings',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      upfrontAmount: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      discount: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      total: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      zoneAdminCommission: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      serviceCharge: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      categoryCharge: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      pickupDriverEarning: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      deliveryDriverEarning: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      paymentStatus: {
        type: Sequelize.ENUM('Paid', 'Pending', 'Failed'),
        defaultValue: 'Pending'
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
    await queryInterface.dropTable('billingDetails');
  }
};