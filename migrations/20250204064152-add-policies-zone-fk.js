'use strict';

/** Add policies.zoneId → zones.id FK (deferred from create-policies for migrate order). */
module.exports = {
  async up(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const normalized = tables.map((t) =>
      typeof t === 'string' ? t.toLowerCase() : String(t).toLowerCase()
    );
    if (!normalized.includes('policies') || !normalized.includes('zones')) {
      return;
    }

    // Idempotent: skip if FK already present (older envs created it in create-policies).
    const [fks] = await queryInterface.sequelize.query(`
      SELECT CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'policies'
        AND COLUMN_NAME = 'zoneId'
        AND REFERENCED_TABLE_NAME = 'zones'
      LIMIT 1
    `);
    if (fks && fks.length) return;

    await queryInterface.addConstraint('policies', {
      fields: ['zoneId'],
      type: 'foreign key',
      name: 'policies_zoneId_fkey',
      references: {
        table: 'zones',
        field: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeConstraint('policies', 'policies_zoneId_fkey');
    } catch (_) {
      // ignore
    }
  },
};
