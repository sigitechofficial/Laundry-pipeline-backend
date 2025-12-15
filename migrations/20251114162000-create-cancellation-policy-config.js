'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('cancellation_policy_configs', {
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
      // Policy Status
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      
      // Pre-Pickup / Driver en-route Section
      prePickupAbsoluteCurrency: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'USD',
        comment: 'Currency for absolute charges'
      },
      prePickupAbsoluteAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Absolute amount to charge for pre-pickup cancellation'
      },
      prePickupPercentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Percentage to charge for pre-pickup cancellation'
      },
      prePickupFreeChargeWindowMinutes: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 120,
        comment: 'Free cancellation window in minutes before pickup'
      },
      prePickupFirstCancellationLeniency: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'On first cancellation order, no charges'
      },
      
      // Unprocessed Section
      unprocessedAbsoluteCurrency: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'USD',
        comment: 'Currency for unprocessed charges'
      },
      unprocessedAbsoluteAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Absolute amount to charge for unprocessed cancellation'
      },
      unprocessedPercentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Percentage to charge for unprocessed cancellation'
      },
      unprocessedAfterPickupMinutes: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 30,
        comment: 'Time window in minutes after pickup to consider as unprocessed'
      },
      unprocessedOrderValuePercentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        defaultValue: 15.00,
        comment: 'Percentage of order value to charge'
      },
      allowCancelUnprocessed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Allow cancellation for unprocessed orders'
      },
      
      // Customer Leniency Section
      courtesyWindowDays: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 30,
        comment: 'Courtesy window in days for customer leniency'
      },
      courtesyCapAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 15.00,
        comment: 'Courtesy cap amount'
      },
      courtesyCount: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 1,
        comment: 'Number of courtesy cancellations allowed'
      },
      customerLeniencyEnabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Enable customer leniency feature'
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
        allowNull: true,
        type: Sequelize.DATE
      }
    });

    // Add indexes
    await queryInterface.addIndex('cancellation_policy_configs', ['policyId'], {
      name: 'cancellation_policy_configs_policy_id_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('cancellation_policy_configs');
  }
};