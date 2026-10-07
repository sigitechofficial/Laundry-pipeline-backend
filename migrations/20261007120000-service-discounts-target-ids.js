'use strict';

const { addColumnIfMissing, columnExists, tableExists } = require('../utils/migrationHelpers');

/**
 * Enterprise: one discount rule can target multiple services / categories /
 * items / add-ons via targetIds JSON. Backfill from legacy single targetId.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'serviceDiscounts'))) return;

    await addColumnIfMissing(queryInterface, 'serviceDiscounts', 'targetIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
      comment: 'Array of target IDs (same type as targetType). Null/[] with targetType=all.',
    });

    if (!(await columnExists(queryInterface, 'serviceDiscounts', 'targetIds'))) return;

    // Backfill: copy legacy targetId → [targetId] where targetIds is empty
    const [rows] = await queryInterface.sequelize.query(`
      SELECT id, targetId, targetIds
      FROM serviceDiscounts
      WHERE targetId IS NOT NULL
        AND targetId > 0
    `);

    for (const row of rows || []) {
      let existing = row.targetIds;
      if (typeof existing === 'string') {
        try {
          existing = JSON.parse(existing);
        } catch (_) {
          existing = null;
        }
      }
      if (Array.isArray(existing) && existing.length) continue;
      await queryInterface.bulkUpdate(
        'serviceDiscounts',
        { targetIds: [Number(row.targetId)] },
        { id: row.id }
      );
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'serviceDiscounts'))) return;
    if (!(await columnExists(queryInterface, 'serviceDiscounts', 'targetIds'))) return;
    await queryInterface.removeColumn('serviceDiscounts', 'targetIds');
  },
};
