'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('otpVerifications', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      OTP: {
        type: Sequelize.STRING(5),
        allowNull: true,
      },
      reqAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      expirtAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      verifiedAtForgetCase: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false,
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
    await queryInterface.dropTable('otpVerifications');
  }
};