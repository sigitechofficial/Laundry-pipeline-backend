'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {

    await queryInterface.bulkInsert('userTypes',[
      {
      name:'Admin',
      createdAt:new Date(),
      updatedAt:new Date()

      },
      {
        name:'Customer',
        createdAt:new Date(),
        updatedAt:new Date()
      },
      {
        name:'Driver',
        createdAt:new Date(),
        updatedAt:new Date()
      },
      {
        name:'Agent',
        createdAt:new Date(),
        updatedAt:new Date()
      }
  ])
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.bulkDelete('userTypes',null,{})
  }
};
