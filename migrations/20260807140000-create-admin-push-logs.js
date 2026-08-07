'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('admin_push_logs', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      audience: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      mode: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(160),
        allowNull: false,
      },
      body: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      targetedUsers: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      usersDelivered: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      usersNoToken: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      usersFailed: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      deviceSuccessCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      deviceFailureCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      sentByAdminId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      payloadJson: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addIndex('admin_push_logs', ['createdAt']);
    await queryInterface.addIndex('admin_push_logs', ['audience']);
    await queryInterface.addIndex('admin_push_logs', ['sentByAdminId']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('admin_push_logs');
  },
};
