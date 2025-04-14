'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.bulkInsert('baseunits',[
      {
        status: 1,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        weightUnitId: 2,
        lengthUnitId: 1,
        distanceUnitId: 3,
        currencyUnitId: 5
      }
    ])
  },

  async down (queryInterface, Sequelize) {
    
    await queryInterface.bulkDelete('baseunits',null,{})
  }
};
