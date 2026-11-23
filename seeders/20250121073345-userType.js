'use strict';

const { insertMissing, deleteSeeded } = require('./helpers/idempotentSeed');

/**
 * User types. Ids are referenced in code: 1 Admin, 2 Customer, 3 Driver, 4 Agent.
 * Idempotent: inserts only missing rows (by id); undo removes only these rows.
 */
const ROWS = [
  { id: 1, name: 'Admin' },
  { id: 2, name: 'Customer' },
  { id: 3, name: 'Driver' },
  { id: 4, name: 'Agent' }
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await insertMissing(queryInterface, 'userTypes', ROWS);
  },

  async down(queryInterface) {
    await deleteSeeded(queryInterface, 'userTypes', ROWS);
  },
};
