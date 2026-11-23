'use strict';

const { insertMissing, deleteSeeded } = require('./helpers/idempotentSeed');

/**
 * Default app units (single row, id 1): lbs, inch, kilometer, GBP.
 * Idempotent: inserts only missing rows (by id); undo removes only these rows.
 */
const ROWS = [
  {
    id: 1,
    status: 1,
    deleted: 0,
    weightUnitId: 2,
    lengthUnitId: 1,
    distanceUnitId: 3,
    currencyUnitId: 5
  }
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await insertMissing(queryInterface, 'appUnits', ROWS);
  },

  async down(queryInterface) {
    await deleteSeeded(queryInterface, 'appUnits', ROWS);
  },
};
