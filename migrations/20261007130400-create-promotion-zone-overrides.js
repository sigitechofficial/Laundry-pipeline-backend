'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('promotion_zone_overrides')) return;

    // Per-zone overrides: one promotion, different discount/cap per zone
    await queryInterface.createTable('promotion_zone_overrides', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      promotionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'promotions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },

      zoneId: { type: Sequelize.INTEGER, allowNull: false },

      discountValue: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      maxDiscountCap: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      minSubtotal: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: true },

      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('promotion_zone_overrides', ['promotionId', 'zoneId'], {
      name: 'idx_pzo_promo_zone',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('promotion_zone_overrides');
  },
};
