'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bussinessInformations', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      shopName: {
        type: Sequelize.STRING
      },
      matchProfileOptions: {
        type: Sequelize.ENUM('ALL IN HOUSE- Washing, Ironing and Dry cleaning all done by us',
          'OUTSOURCE DRY CLEANING- Washing and Drying handled in house',
          'OUTSOURCE ALL- We are just a shop front that outsources all of the processing',
          'Other'),
        allowNull: true,
      },
      otherText:{
        type:Sequelize.STRING(500),
        allowNull:true
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
    await queryInterface.dropTable('bussinessInformations');
  }
};