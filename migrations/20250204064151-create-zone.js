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
        type: Sequelize.STRING
      },
      coordinates: {
        type: Sequelize.GEOMETRY('POLYGON')
      },
      status: {
        type: Sequelize.BOOLEAN
      },
      zoneMinimumAmount:{
        type:Sequelize.DECIMAL(20,2)
      },
      serviceCharge:{
        type:Sequelize.FLOAT
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
    await queryInterface.dropTable('zones');
  }
};