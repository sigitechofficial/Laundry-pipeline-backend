'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = async (name) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${name}'`
      );
      return rows[0].cnt > 0;
    };

    if (await tableExists('coupon_codes')) return;

    await queryInterface.createTable('coupon_codes', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },

      promotionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'promotions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },

      code: { type: Sequelize.STRING(50), allowNull: false },

      // Code type
      codeType: {
        type: Sequelize.ENUM('shared', 'unique', 'customer_bound', 'partner', 'bulk'),
        allowNull: false,
        defaultValue: 'shared',
      },

      // Optional customer assignment
      customerId: { type: Sequelize.INTEGER, allowNull: true, comment: 'For customer_bound codes' },
      partnerRef: { type: Sequelize.STRING(100), allowNull: true, comment: 'Influencer/partner reference' },

      // Limits (can override promotion-level limits)
      usageLimit: { type: Sequelize.INTEGER, allowNull: true },
      perCustomerLimit: { type: Sequelize.INTEGER, allowNull: true },
      usedCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      // Dates (can override promotion dates)
      activationDate: { type: Sequelize.DATE, allowNull: true },
      expiryDate: { type: Sequelize.DATE, allowNull: true },

      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },

      createdBy: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('coupon_codes', ['code'], { name: 'idx_cc_code', unique: true });
    await queryInterface.addIndex('coupon_codes', ['promotionId'], { name: 'idx_cc_promotion' });
    await queryInterface.addIndex('coupon_codes', ['customerId'], { name: 'idx_cc_customer' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('coupon_codes');
  },
};
