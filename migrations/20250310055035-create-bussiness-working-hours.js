'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bussinessWorkingHours', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      dayOfWeek: {
        type: Sequelize.ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'),
        allowNull: false,
      },
      openTime: {
        type: Sequelize.TIME,
        allowNull: true,
        defaultValue: '07:00:00'
      },
      closeTime: {
        type: Sequelize.TIME,
        allowNull: true,
        defaultValue: '19:00:00'
      },
      status: {
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
    await queryInterface.dropTable('bussinessWorkingHours');
  }
};