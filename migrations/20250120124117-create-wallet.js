'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallets', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      amount: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true,
        defaultValue: '0.00'
      },
      currency: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: '$'
      },
      description: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: ''
      },
      type: {
        type: Sequelize.ENUM('credit', 'debit'),
        allowNull: false,
        defaultValue: 'credit'
      },
      status: {
        type: Sequelize.ENUM('pending', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'completed'
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
    await queryInterface.dropTable('wallets');
  }
};