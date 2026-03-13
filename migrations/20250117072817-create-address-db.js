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
        allowNull: true,
      },
      customAddressTitle: {
        type: Sequelize.STRING(40),
        allowNull: true,
      },
      hotelName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      apartmentNumber: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      floor: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      streetAddress: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      district: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      province: {
        type: Sequelize.STRING,
        allowNull: true
      },
      postalcode: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      lat: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      lng: {
        type: Sequelize.STRING,
        allowNull: false
      },
      status: {
        type: Sequelize.BOOLEAN,
        defaultValue: 1
      },
      radius: {
        type: Sequelize.DECIMAL,
        allowNull: true
      },
      addressType: {
        type: Sequelize.ENUM('dropOff','pickUp','LaundaryShopAddress'),
        allowNull: true
      },
      coordinates: {
        type: Sequelize.GEOMETRY('POLYGON'),
        allowNull: true
      },
      isDefault: {
        type: Sequelize.BOOLEAN,
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
    await queryInterface.dropTable('addressDbs');
  }
};