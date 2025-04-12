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

    await queryInterface.bulkInsert('users',[
      {
        firstName:'admin',
        lastName:'Laundary',
        email:'admin@gmail.com',
        phoneNum:'03434545444',
        status:true,
        userTypeId:1,
        password:'$2a$08$p9YCuWEiYpbZES/e8k5z2.B9IzPeopfRcDMjAvxpuor9A2eka1ejK',
        createdAt:new Date(),
        updatedAt:new Date(),
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

    await queryInterface.bulkDelete('users',null,{})
  }
};
