'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.bulkInsert('classifiedAs',[
      {
        id:1,
        name:'Laundry Shop',
        createdAt:new Date(),
        updatedAt:new Date()
      },
      {
        id:2,
        name:'Admin Employee',
        createdAt:new Date(),
        updatedAt:new Date()
        
      }
    ])
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.bulkDelete('classifiedAs',null,{})
  }
};
