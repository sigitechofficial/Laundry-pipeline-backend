'use strict';

const { insertMissing, deleteSeeded } = require('./helpers/idempotentSeed');

/**
 * Measurement and currency units. Ids are referenced by appUnits/baseUnits (2 lbs, 1 inch, 3 km, 5 GBP). The former test rows (8 'test', 9 'Kiran') are no longer seeded.
 * Idempotent: inserts only missing rows (by id); undo removes only these rows.
 */
const ROWS = [
  {
    id: 1,
    type: 'length',
    name: 'inch',
    symbol: 'in',
    desc: null,
    status: 1,
    conversionRate: 1,
    deleted: 0
  },
  {
    id: 2,
    type: 'weight',
    name: 'lbs',
    symbol: 'lbs',
    desc: null,
    status: 1,
    conversionRate: 1,
    deleted: 0
  },
  {
    id: 3,
    type: 'distance',
    name: 'kilometer',
    symbol: 'km',
    desc: null,
    status: 1,
    conversionRate: 1,
    deleted: 0
  },
  {
    id: 4,
    type: 'currency',
    name: 'USD',
    symbol: '$',
    desc: null,
    status: 1,
    conversionRate: 1,
    deleted: 0
  },
  {
    id: 5,
    type: 'currency',
    name: 'GBP',
    symbol: '£',
    desc: null,
    status: 1,
    conversionRate: 1,
    deleted: 0
  },
  {
    id: 6,
    type: 'length',
    name: 'cm',
    symbol: 'cm',
    desc: null,
    status: 1,
    conversionRate: 1,
    deleted: 0
  },
  {
    id: 7,
    type: 'weight',
    name: 'kilogram',
    symbol: 'kg',
    desc: null,
    status: 1,
    conversionRate: 0.4536,
    deleted: 0
  }
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await insertMissing(queryInterface, 'units', ROWS);
  },

  async down(queryInterface) {
    await deleteSeeded(queryInterface, 'units', ROWS);
  },
};
