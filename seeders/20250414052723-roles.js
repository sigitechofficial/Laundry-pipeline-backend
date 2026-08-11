'use strict';

/**
 * Idempotent system roles:
 *   6 = Laundry Shop Driver   → Agent shop employees (classifiedAs 1)
 *   7 = Zone Admin            → Admin employees (classifiedAs 2)
 *   8 = Laundry Shop Manager  → Agent shop employees (classifiedAs 1)
 *
 * Do not delete these IDs. Admin and Agent employee audiences must stay separate.
 */

const SYSTEM_ROLES = [
  { id: 6, name: 'Laundry Shop Driver', status: 1 },
  { id: 7, name: 'Zone Admin', status: 1 },
  { id: 8, name: 'Laundry Shop Manager', status: 1 },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    for (const role of SYSTEM_ROLES) {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT id FROM roles WHERE id = ${role.id} LIMIT 1`
      );
      if (rows && rows.length > 0) {
        await queryInterface.sequelize.query(
          `UPDATE roles SET name = :name, status = :status, updatedAt = :updatedAt WHERE id = :id`,
          {
            replacements: {
              id: role.id,
              name: role.name,
              status: role.status,
              updatedAt: now,
            },
          }
        );
        continue;
      }
      await queryInterface.bulkInsert('roles', [
        {
          id: role.id,
          name: role.name,
          status: role.status,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
  },

  async down(queryInterface) {
    // Never wipe system roles on down in shared environments.
    void queryInterface;
  },
};
