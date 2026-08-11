'use strict';

/**
 * Employee kinds (keep Admin vs Agent shop staff separate):
 *   1 = Laundry Shop Employee  → agent app (roles 6 Driver / 8 Manager)
 *   2 = Admin Employee         → admin / zone portal (role 7 Zone Admin)
 */

const ROWS = [
  { id: 1, name: 'Laundry Shop Employee' },
  { id: 2, name: 'Admin Employee' },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    for (const row of ROWS) {
      const [existing] = await queryInterface.sequelize.query(
        `SELECT id FROM classifiedAs WHERE id = ${row.id} LIMIT 1`
      );
      if (existing && existing.length > 0) {
        await queryInterface.sequelize.query(
          `UPDATE classifiedAs SET name = :name, updatedAt = :updatedAt WHERE id = :id`,
          {
            replacements: {
              id: row.id,
              name: row.name,
              updatedAt: now,
            },
          }
        );
        continue;
      }
      await queryInterface.bulkInsert('classifiedAs', [
        {
          id: row.id,
          name: row.name,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
  },

  async down() {
    // Keep system classifiedAs rows.
  },
};
