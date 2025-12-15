'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('addressDbs', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      title: {
        type: Sequelize.ENUM('Office','Home','Other','Hotel'),
        allowNull:false,
      },
      customAddressTitle:{
        type:Sequelize.STRING(40),
        allowNull:true,
      },
      hotelName:{
        type:Sequelize.STRING,
        allowNull:true
      },
      apartmentNumber:{
        type:Sequelize.INTEGER,
        allowNull:true
      },
      floor:{
        type:Sequelize.INTEGER,
        allowNull:true,
      },
      streetAddress: {
        type: Sequelize.STRING,
        allowNull:false,
      },
      district: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      province: {
        type: Sequelize.STRING,
        allowNull:true
      },
      postalcode: {
        type: Sequelize.STRING,
        allowNull:true,
      },
      lat: {
        type: Sequelize.DECIMAL,
        allowNull:false,
      },
      lng: {
        type: Sequelize.DECIMAL,
        allowNull:false
      },
      status: {
        type: Sequelize.BOOLEAN,
        defaultValue:1
      },
      addressType:{
        type:Sequelize.ENUM('dropOff','pickUp','LaundaryShopAddress'),
        allowNull:true
      },
      coordinates:{
        type:Sequelize.GEOMETRY('POLYGON'),
        allowNull:true
      },
      radius:{
        type:Sequelize.DECIMAL,
        allowNull:true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      isDefault:{
        type:Sequelize.BOOLEAN,
        defaultValue:false
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('addressDbs');
  }
};