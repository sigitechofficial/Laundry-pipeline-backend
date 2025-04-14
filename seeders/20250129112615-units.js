'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {

    await queryInterface.bulkInsert('units',[
      {
        type: 'length',
        name: 'inch',
        symbol: 'in',
        desc: null,
        status: 1,
        conversionRate: 1.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'weight',
        name: 'lbs',
        symbol: 'lbs',
        desc: null,
        status: 1,
        conversionRate: 1.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'distance',
        name: 'kilometer',
        symbol: 'km',
        desc: null,
        status: 1,
        conversionRate: 1.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'currency',
        name: 'USD',
        symbol: '$',
        desc: null,
        status: 1,
        conversionRate: 1.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'currency',
        name: 'GBP',
        symbol: '£',
        desc: null,
        status: 1,
        conversionRate: 1.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'length',
        name: 'cm',
        symbol: 'cm',
        desc: null,
        status: 1,
        conversionRate: 1.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'weight',
        name: 'kilogram',
        symbol: 'kg',
        desc: null,
        status: 1,
        conversionRate: 0.4536,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'distance',
        name: 'test',
        symbol: 'test',
        desc: null,
        status: 1,
        conversionRate: 2.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        type: 'currency',
        name: 'Kiran',
        symbol: 'k',
        desc: null,
        status: 1,
        conversionRate: 11.0000,
        deleted: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ])
  },

  async down (queryInterface, Sequelize) {

    await queryInterface.bulkDelete('units',null,{})
  }
};
