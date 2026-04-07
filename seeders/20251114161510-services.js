'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.bulkInsert('services', [
      {
        id: 1,
        name: 'Wash & Fold',
        description: 'Professional washing and folding service for your everyday laundry needs.',
        status: true,
        image: null,
        timeRequired: '24-48 hours',
        pricingBasis: 'weight',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 2,
        name: 'Wash & Iron',
        description: 'Complete washing and ironing service to keep your clothes crisp and fresh.',
        status: true,
        image: null,
        timeRequired: '24-48 hours',
        pricingBasis: 'item',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 3,
        name: 'Dry Clean',
        description: 'Professional dry cleaning service for delicate and special care garments.',
        status: true,
        image: null,
        timeRequired: '48-72 hours',
        pricingBasis: 'item',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 4,
        name: 'Press Only',
        description: 'Ironing and pressing service for clothes that are already clean.',
        status: true,
        image: null,
        timeRequired: '12-24 hours',
        pricingBasis: 'item',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 5,
        name: 'Wash, Dry & Fold',
        description: 'Complete laundry service including washing, drying, and folding.',
        status: true,
        image: null,
        timeRequired: '24-48 hours',
        pricingBasis: 'weight',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 6,
        name: 'Express Service',
        description: 'Fast-track laundry service for urgent orders. Same day or next day delivery available.',
        status: true,
        image: null,
        timeRequired: '12-24 hours',
        pricingBasis: 'weight',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 7,
        name: 'Delicate Wash',
        description: 'Special care washing service for delicate fabrics and items requiring gentle treatment.',
        status: true,
        image: null,
        timeRequired: '48-72 hours',
        pricingBasis: 'item',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: 8,
        name: 'Bedding & Linens',
        description: 'Professional cleaning service for bed sheets, pillowcases, and other household linens.',
        status: true,
        image: null,
        timeRequired: '48-72 hours',
        pricingBasis: 'item',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ])
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('services', null, {})
  }
};

