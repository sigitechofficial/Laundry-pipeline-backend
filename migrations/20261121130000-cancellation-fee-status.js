'use strict';

/**
 * cancelBookings: what happened to the cancellation fee, so a fee that could not be taken is
 * recorded as owed (and shown to admin) instead of disappearing.
 *   feeAmount   – the fee the policy gave
 *   feeStatus   – none | retained (kept from what was prepaid) | charged (card charged) | owed (not collected)
 *   feeOwed     – the part not collected
 *   feeError    – why it was not collected (card declined, no saved card, cash order…)
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const has = async (column) => {
      const [[{ cnt }]] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'cancelBookings' AND column_name = '${column}'`
      );
      return cnt > 0;
    };
    const add = async (column, spec) => { if (!(await has(column))) await queryInterface.addColumn('cancelBookings', column, spec); };
    await add('feeAmount', { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await add('feeCurrency', { type: Sequelize.STRING(10), allowNull: true });
    await add('feeStatus', { type: Sequelize.STRING(16), allowNull: true });
    await add('feeOwed', { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await add('feeError', { type: Sequelize.STRING(500), allowNull: true });
  },

  async down(queryInterface) {
    for (const c of ['feeError', 'feeOwed', 'feeStatus', 'feeCurrency', 'feeAmount']) {
      await queryInterface.removeColumn('cancelBookings', c);
    }
  },
};
