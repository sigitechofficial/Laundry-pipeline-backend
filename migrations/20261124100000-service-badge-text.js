'use strict';

/**
 * services.badgeText: short label shown on the service in the customer and shop apps
 * (e.g. "Premium · Eco" on Eco Dry Clean). Empty = no badge.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [[{ cnt }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'services' AND column_name = 'badgeText'`
    );
    if (cnt > 0) return;
    await queryInterface.addColumn('services', 'badgeText', {
      type: Sequelize.STRING(30),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('services', 'badgeText');
  },
};
