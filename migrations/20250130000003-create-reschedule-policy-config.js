'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First, update the policy enum to include 'reschedule'
    await queryInterface.sequelize.query(`
      ALTER TABLE policies 
      MODIFY COLUMN type ENUM('no_show', 'cancellation', 'late_pickup', 'late_delivery', 'reschedule') 
      NOT NULL DEFAULT 'no_show';
    `);

    // Create reschedule_policy_configs table
    await queryInterface.createTable('reschedule_policy_configs', {
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
        defaultValue: true,
        comment: 'Reschedule policy toggle'
      },
      
      // At Pickup Section
      atPickupAbsoluteCurrency: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'USD',
        comment: 'Currency for absolute charges at pickup'
      },
      atPickupAbsoluteAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Absolute amount to charge for reschedule at pickup'
      },
      atPickupPercentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Percentage to charge for reschedule at pickup'
      },
      atPickupCourtesyCount: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 1,
        comment: 'Number of courtesy reschedules allowed at pickup'
      },
      atPickupCourtesyCountEnabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Enable courtesy count at pickup'
      },
      
      // At Delivery Section
      atDeliveryAbsoluteCurrency: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'USD',
        comment: 'Currency for absolute charges at delivery'
      },
      atDeliveryAbsoluteAmount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Absolute amount to charge for reschedule at delivery'
      },
      atDeliveryPercentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Percentage to charge for reschedule at delivery'
      },
      atDeliveryCourtesyCount: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 1,
        comment: 'Number of courtesy reschedules allowed at delivery'
      },
      atDeliveryCourtesyCountEnabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Enable courtesy count at delivery'
      },
      
      // Customer Leniency Section
      courtesyWindowDays: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 30,
        comment: 'Courtesy window in days (or minutes if less than 1 day)'
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
        comment: 'Number of courtesy reschedules allowed'
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
    await queryInterface.addIndex('reschedule_policy_configs', ['policyId'], {
      name: 'reschedule_policy_configs_policy_id_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('reschedule_policy_configs');
    
    // Revert the enum change (remove 'reschedule')
    await queryInterface.sequelize.query(`
      ALTER TABLE policies 
      MODIFY COLUMN type ENUM('no_show', 'cancellation', 'late_pickup', 'late_delivery') 
      NOT NULL DEFAULT 'no_show';
    `);
  }
};

