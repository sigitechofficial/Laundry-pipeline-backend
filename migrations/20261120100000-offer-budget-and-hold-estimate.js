'use strict';

/**
 * Simple offers (docs/PROMOTIONS_CHECKOUT_PLAN.md, "Offer budget"):
 *  - campaigns.ownerPromotionId: a budget pool that belongs to one offer (its own £ budget,
 *    set on the offer form). Null = a shared budget several offers draw from.
 *  - promotion_redemptions.estimatedAmount: what a booking's hold is expected to cost the
 *    budget until the shop prices it, so new orders stop before the budget runs out.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const hasColumn = async (table, column) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}'`
      );
      return rows[0].cnt > 0;
    };

    if (!(await hasColumn('campaigns', 'ownerPromotionId'))) {
      await queryInterface.addColumn('campaigns', 'ownerPromotionId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: "Set when this budget belongs to one offer (its own budget); null = shared budget",
      });
    }
    if (!(await hasColumn('promotion_redemptions', 'estimatedAmount'))) {
      await queryInterface.addColumn('promotion_redemptions', 'estimatedAmount', {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        comment: 'Expected cost of an unpriced hold to its budget (offer on a minimum order)',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('promotion_redemptions', 'estimatedAmount');
    await queryInterface.removeColumn('campaigns', 'ownerPromotionId');
  },
};
