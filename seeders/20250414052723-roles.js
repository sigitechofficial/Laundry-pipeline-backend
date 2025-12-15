'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.bulkInsert('roles',[
      {
        id:6,
        name:'Laundry Shop Driver',
        status:1,
        createdAt:new Date(),
        updatedAt:new Date()
      },
      {
        id:7,
        name:'Zone Admin',
        status:1,
        createdAt:new Date(),
        updatedAt:new Date()
      }
    ])
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.bulkDelete('roles',null,{})
  }
};
