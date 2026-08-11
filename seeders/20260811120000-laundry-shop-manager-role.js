'use strict';

/**
 * Seed Laundry Shop Manager role for agent-app team members.
 * Driver = 6 (existing). Manager = 8.
 */
module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query(
      `SELECT id, name FROM roles WHERE id = 8 OR LOWER(name) = 'laundry shop manager' LIMIT 5;`
    );

    if (existing && existing.length > 0) {
      return;
    }

    await queryInterface.bulkInsert('roles', [
      {
        id: 8,
        name: 'Laundry Shop Manager',
        status: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('roles', {
      id: 8,
      name: 'Laundry Shop Manager',
    });
  },
};
