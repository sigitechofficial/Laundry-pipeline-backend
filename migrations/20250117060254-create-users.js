'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      firstName: {
        allowNull:false,
        type: Sequelize.STRING,
      },
      lastName: {
        type: Sequelize.STRING,
        allowNull:false,
      },
      email: {
        type: Sequelize.STRING,
        allowNull:true,
        unique:true,
        validate:{
          isEmail:true
        }
      },
      password: {
        type: Sequelize.STRING,
        allowNull:false,
      },
      phoneNum: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      stripeCustomerId: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      dvToken: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      image: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      deletedAt: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      signedFrom: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull:false,
        defaultValue:1
      },
      verifiedAt: {
        type: Sequelize.STRING,
        allowNull:true
      },
      laundaryShopName:{
        type:Sequelize.STRING,
        allowNull:true
      },
      driverType:{
        type:Sequelize.ENUM('Freelance Driver','laundary Shop Driver'),
        allowNull:true
      },
      employeeOff:{
        type:Sequelize.INTEGER,
        allowNull:true,
        defaultValue:null
      },
      countryCode:{
      type:Sequelize.STRING,
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
    await queryInterface.dropTable('users');
  }
};