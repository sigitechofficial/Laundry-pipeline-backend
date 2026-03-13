'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bookings', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      orderTrackId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      collectionDate: {
        type: Sequelize.DATE,
        allowNull: false
      },
      collectionTimeTo: {
        type: Sequelize.TIME,
        allowNull: false
      },
      collectionTimeFrom: {
        type: Sequelize.TIME,
        allowNull: false
      },
      driverInstructionOptions: {
        type: Sequelize.ENUM('Collect from me in person', 'Collect from Outside', 'Collect from reception/Porter', 'Collect from the reception'),
        allowNull: false,
      },
      driverInstructionOptions1: {
        type: Sequelize.ENUM('Deliver to me in person', 'Leave at the door', 'Deliver to the Reception/Porter')
      },
      driverInstruction: {
        type: Sequelize.STRING,
        allowNull: true
      },
      paymentConfirmed: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      partialPayment: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      totalItems: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      orderAmount: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      subTotal: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      frequency: {
        type: Sequelize.ENUM('Just Once', 'Weekly', 'Every two weeks', 'Every four weeks'),
        allowNull: false,
        defaultValue: 'Just Once'
      },
      deliveryDate: {
        type: Sequelize.DATE,
        allowNull: false
      },
      deliveryTimeFrom: {
        type: Sequelize.TIME,
        allowNull: false
      },
      deliveryTimeTo: {
        type: Sequelize.TIME,
        allowNull: false
      },
      orderExpireTime: {
        type: Sequelize.TIME,
        allowNull: true,
      },
      onHoldReason: {
        type: Sequelize.ENUM(
          'Missing or Damaged Items .Items lost or damaged, requiring customer verification.',
          'Special Instructions Pending. Waiting for customer confirmation on delicate fabrics, stains, or specific washing preferences.',
          'Damaged or Shrinking Risk . Items that may shrink, bleed color, or have pre-existing damage, requiring approval before proceeding.',
          'Incorrect Tagging or Sorting. Mislabeling or mixing up orders requiring manual sorting.',
          'Damage Liability Waiver Needed.sDelicate or high-risk items need the customer to sign a waiver before cleaning.',
          'Other'
        ),
        allowNull: true,
      },
      OnHoldOtherReason: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      paymentMethodId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      paymentIntentId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      setupIntentId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      rescheduledCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      rescheduleReason: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      rescheduleCharge: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0.00
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true
      }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bookings');
  }
};