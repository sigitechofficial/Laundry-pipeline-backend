'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('policies', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      type: {
        type: Sequelize.ENUM('no_show', 'cancellation', 'late_pickup', 'late_delivery'),
        allowNull: false,
        defaultValue: 'no_show'
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      isDefault: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      // FK to zones added after zones table exists (see 20250204064152-add-policies-zone-fk).
      // Creating the FK here breaks greenfield migrate because zones is created later.
      zoneId: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      updatedBy: {
        type: Sequelize.INTEGER,
        allowNull: true
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
    await queryInterface.addIndex('policies', ['type', 'isActive']);
    await queryInterface.addIndex('policies', ['type', 'isDefault']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('policies');
  }
};
