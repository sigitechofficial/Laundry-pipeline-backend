'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('zones', {
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
      coordinates: {
        type: Sequelize.GEOMETRY('POLYGON')
      },
      status: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      zoneMinimumAmount: {
        type: Sequelize.DECIMAL(5,2),
        allowNull: true
      },
      zoneAdminComission: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      serviceCharge: {
        type: Sequelize.FLOAT,
        allowNull: true
      },
      paymentMehtod: {
        type: Sequelize.ENUM('Cash','Stripe','Paypal'),
        allowNull: true,
        defaultValue: 'Cash'
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
    await queryInterface.dropTable('zones');
  }
};