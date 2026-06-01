'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('services', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description: {
        type: Sequelize.STRING(300),
        allowNull: true
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: 1
      },
      image: {
        type: Sequelize.STRING,
        allowNull: true
      },
      timeRequired: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      pricingBasis: {
        type: Sequelize.ENUM('weight', 'item'),
        allowNull: true,
        defaultValue: 'item'
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 0
      },
      numberOfBags: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      numberOfItems: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
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
    await queryInterface.dropTable('services');
  }
};