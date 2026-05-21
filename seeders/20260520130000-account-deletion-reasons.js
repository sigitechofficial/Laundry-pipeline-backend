'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await queryInterface.bulkInsert('accountDeletionReasons', [
      { label: 'Had an issue with a shop', sortOrder: 1, status: true, isOther: false, createdAt: now, updatedAt: now },
      { label: "The shop I use isn't on Trim", sortOrder: 2, status: true, isOther: false, createdAt: now, updatedAt: now },
      { label: "Can't find the services I need", sortOrder: 3, status: true, isOther: false, createdAt: now, updatedAt: now },
      { label: 'Technical issues', sortOrder: 4, status: true, isOther: false, createdAt: now, updatedAt: now },
      { label: 'I no longer use Trim', sortOrder: 5, status: true, isOther: false, createdAt: now, updatedAt: now },
      { label: 'Other', sortOrder: 6, status: true, isOther: true, createdAt: now, updatedAt: now },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('accountDeletionReasons', null, {});
  },
};
