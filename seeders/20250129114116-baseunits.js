'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add seed commands here.
     *
     * Example:
     * await queryInterface.bulkInsert('People', [{
     *   name: 'John Doe',
     *   isBetaMember: false
     * }], {});
    */

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
    /**
     * Add commands to revert seed here.
     *
     * Example:
     * await queryInterface.bulkDelete('People', null, {});
     */
    await queryInterface.bulkDelete('baseunits',null,{})
  }
};
