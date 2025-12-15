'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('OnHoldConfirmations', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      onHoldImg: {
        type: Sequelize.STRING
      },
      noOfItems: {
        type: Sequelize.INTEGER
      },
      description: {
        type: Sequelize.STRING
      },
      deleted:{
        type:Sequelize.BOOLEAN,
        defaultValue:false
      },
      responseConformation:{
        type:Sequelize.BOOLEAN,
        defaultValue:false,
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
    await queryInterface.dropTable('OnHoldConfirmations');
  }
};