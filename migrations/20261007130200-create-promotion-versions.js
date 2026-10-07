'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('promotion_versions')) return;

    await queryInterface.createTable('promotion_versions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      promotionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'promotions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },

      versionNumber: { type: Sequelize.INTEGER, allowNull: false },

      // Full immutable snapshot of the promotion config at publish time
      configSnapshot: {
        type: Sequelize.JSON,
        allowNull: false,
        comment: 'Immutable copy of all rules, benefit, zones, targets, limits at publish time',
      },

      publishedAt: { type: Sequelize.DATE, allowNull: true },
      publishedBy: { type: Sequelize.INTEGER, allowNull: true },
      reason: { type: Sequelize.STRING(500), allowNull: true, comment: 'Why this version was published' },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('promotion_versions', ['promotionId', 'versionNumber'], {
      name: 'idx_pv_promotion_version',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('promotion_versions');
  },
};
