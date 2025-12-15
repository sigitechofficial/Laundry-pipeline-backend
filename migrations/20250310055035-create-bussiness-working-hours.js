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
        type: Sequelize.ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')
      },
      openTime: {
        type: Sequelize.TIME
      },
      closeTime: {
        type: Sequelize.TIME
      },
      status:{
        type:Sequelize.BOOLEAN,
        allowNull:false,
        defaultValue:false
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
    await queryInterface.dropTable('bussinessWorkingHours');
  }
};