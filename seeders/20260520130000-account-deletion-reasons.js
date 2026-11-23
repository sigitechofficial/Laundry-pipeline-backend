'use strict';

const { insertMissing, deleteSeeded } = require('./helpers/idempotentSeed');

/**
 * Reasons offered when a customer deletes their account.
 * Idempotent: inserts only missing rows (by label); undo removes only these rows.
 */
const ROWS = [
  { label: 'Had an issue with a shop', sortOrder: 1, status: true, isOther: false },
  { label: "The shop I use isn't on Trim", sortOrder: 2, status: true, isOther: false },
  { label: "Can't find the services I need", sortOrder: 3, status: true, isOther: false },
  { label: 'Technical issues', sortOrder: 4, status: true, isOther: false },
  { label: 'I no longer use Trim', sortOrder: 5, status: true, isOther: false },
  { label: 'Other', sortOrder: 6, status: true, isOther: true },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await insertMissing(queryInterface, 'accountDeletionReasons', ROWS, { key: 'label' });
  },

  async down(queryInterface) {
    await deleteSeeded(queryInterface, 'accountDeletionReasons', ROWS, { key: 'label' });
  },
};
