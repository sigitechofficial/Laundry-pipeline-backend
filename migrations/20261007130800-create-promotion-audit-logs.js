'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('promotion_audit_logs')) return;

    await queryInterface.createTable('promotion_audit_logs', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      entityType: {
        type: Sequelize.ENUM('campaign', 'promotion', 'coupon_code', 'redemption', 'adjustment'),
        allowNull: false,
      },
      entityId: { type: Sequelize.INTEGER, allowNull: false },

      action: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'created, updated, published, approved, paused, archived, deleted, etc.',
      },

      actorId: { type: Sequelize.INTEGER, allowNull: true },
      actorType: { type: Sequelize.STRING(20), allowNull: true, comment: 'admin, system, customer' },

      oldValue: { type: Sequelize.JSON, allowNull: true },
      newValue: { type: Sequelize.JSON, allowNull: true },

      reason: { type: Sequelize.STRING(500), allowNull: true },
      correlationId: { type: Sequelize.STRING(100), allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('promotion_audit_logs', ['entityType', 'entityId'], { name: 'idx_pal_entity' });
    await queryInterface.addIndex('promotion_audit_logs', ['actorId'], { name: 'idx_pal_actor' });
    await queryInterface.addIndex('promotion_audit_logs', ['createdAt'], { name: 'idx_pal_created' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('promotion_audit_logs');
  },
};
