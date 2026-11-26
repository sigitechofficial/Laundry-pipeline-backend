'use strict';

/**
 * OnHoldConfirmations: the customer's own note and when things happened, so the
 * shop's issue text is never overwritten and admin can see the timeline.
 *   customerNote – what the customer wrote when answering (was appended to description)
 *   respondedAt  – when the customer answered this item
 *   resolvedAt   – when the shop finished the hold and the order went back to processing
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const has = async (column) => {
      const [[{ cnt }]] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'OnHoldConfirmations' AND column_name = '${column}'`
      );
      return cnt > 0;
    };
    const add = async (column, spec) => { if (!(await has(column))) await queryInterface.addColumn('OnHoldConfirmations', column, spec); };
    await add('customerNote', { type: Sequelize.TEXT, allowNull: true });
    await add('respondedAt', { type: Sequelize.DATE, allowNull: true });
    await add('resolvedAt', { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    for (const c of ['resolvedAt', 'respondedAt', 'customerNote']) {
      await queryInterface.removeColumn('OnHoldConfirmations', c);
    }
  },
};
