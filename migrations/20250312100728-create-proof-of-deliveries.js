'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('proofOfDeliveries', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      imgUpload: {
        type: Sequelize.STRING
      },
      noOfItems: {
        type: Sequelize.INTEGER
      },
      note: {
        type: Sequelize.STRING
      },
      deliveryType: {
        type: Sequelize.ENUM('pickUp', 'dropOff'),
        allowNull: false
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
    await queryInterface.dropTable('proofOfDeliveries');
  }
};