'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bookings', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      orderTrackId: {
        type: Sequelize.STRING
      },
      collectionDate: {
        type: Sequelize.DATE
      },
      collectionTime: {
        type: Sequelize.TIME
      },
      driverInstruction: {
        type: Sequelize.STRING
      },
      paymentConfirmed: {
        type: Sequelize.BOOLEAN
      },
      partialPayment: {
        type: Sequelize.BOOLEAN
      },
      totalItems: {
        type: Sequelize.INTEGER
      },
      orderAmount: {
        type: Sequelize.FLOAT
      },
      frequency: {
        type: Sequelize.ENUM('Just Once','Weekly','Every two weeks','Every four weeks')
      },
      deliveryDate: {
        type: Sequelize.DATE
      },
      deliveryTime: {
        type: Sequelize.TIME
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      onHoldReason:{
        type:Sequelize.STRING,
        allowNull:true,
        defaultValue:""
      },
      driverInstructionOptions:{
        type:DataTypes.ENUM('Collect from me in person','Collect from Outside','Collect from reception/Porter'),
        allowNull:false,
      },
      driverInstructionOptions1:{
        type:DataTypes.ENUM('Deliver to me in person','Leave at the door','Deliver to the Reception/Porter')
      },
      driverInstruction: {
        type:DataTypes.STRING,
      allowNull:true
    },
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bookings');
  }
};