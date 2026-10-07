'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('campaigns')) return;

    await queryInterface.createTable('campaigns', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      name: { type: Sequelize.STRING(200), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      objective: { type: Sequelize.STRING(255), allowNull: true, comment: 'e.g. acquisition, retention, reactivation' },
      channel: { type: Sequelize.STRING(100), allowNull: true, comment: 'marketing channel: google, meta, influencer, organic' },

      budgetMinor: { type: Sequelize.INTEGER, allowNull: true, comment: 'Total budget in minor units (pence/cents)' },
      usedBudgetMinor: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'GBP' },

      startDate: { type: Sequelize.DATEONLY, allowNull: true },
      endDate: { type: Sequelize.DATEONLY, allowNull: true },

      status: {
        type: Sequelize.ENUM('draft', 'active', 'paused', 'completed', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },

      createdBy: { type: Sequelize.INTEGER, allowNull: true },
      updatedBy: { type: Sequelize.INTEGER, allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('campaigns', ['status'], { name: 'idx_campaigns_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('campaigns');
  },
};
