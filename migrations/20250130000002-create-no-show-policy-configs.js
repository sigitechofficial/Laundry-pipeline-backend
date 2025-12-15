'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('no_show_policy_configs', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      policyId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'policies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      // Basic Settings
      enableForPickup: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      enableForDelivery: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      useUnifiedFee: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      
      // Fee Configuration
      feeType: {
        type: Sequelize.ENUM('absolute', 'percentage', 'both'),
        allowNull: false,
        defaultValue: 'absolute'
      },
      currency: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'USD'
      },
      pickupNoShowFee: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 15.00
      },
      deliveryNoShowFee: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 20.00
      },
      storageFeePerDay: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 1.00
      },
      percentageFee: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Percentage fee (e.g., 5.00 for 5%)'
      },
      
      // Eligibility Configuration
      graceMinutesOnSite: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 15,
        comment: 'Minutes to wait before no-show applies'
      },
      driverLateSLA: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 30,
        comment: 'Driver late SLA in minutes - auto-waive if exceeded'
      },
      callsMinutes: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 5,
        comment: 'Minutes to wait before no-show applies for calls'
      },
      smsMinutes: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 5,
        comment: 'Minutes to wait before no-show applies for SMS'
      },
      
      // Unattended Options
      pickupBagAtDoor: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      deliveryLeaveAtDoor: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      concierge: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      locker: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      requirePhoto: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      
      // Waivers & Caps
      waiverType: {
        type: Sequelize.ENUM('absolute', 'percentage', 'both'),
        allowNull: true,
        defaultValue: 'absolute'
      },
      absoluteWaiverAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Absolute amount for auto-waive'
      },
      percentageWaiverAmount: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Percentage of order value for auto-waive'
      },
      autoForgiveFirstNoShow: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      autoForgiveCount: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 1,
        comment: 'Number of no-shows to auto-forgive'
      },
      autoForgivePeriod: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 30,
        comment: 'Period in days for auto-forgive'
      },
      requirePaymentAfterCap: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      perCustomerCap: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 3,
        comment: 'Maximum charges per customer'
      },
      capWindowDays: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 90,
        comment: 'Window in days for cap calculation'
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
        type: Sequelize.DATE
      }
    });

    // Add indexes
    await queryInterface.addIndex('no_show_policy_configs', ['policyId']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('no_show_policy_configs');
  }
};
