'use strict';

/**
 * campaigns.currency: the currency of a campaign's budget, chosen by the admin.
 *
 * A campaign has no zone, so nothing can supply its currency; the column used to default
 * to 'GBP', which silently labelled every budget (and every offer's own budget, whose
 * insert named none) as GBP. Now:
 *  - no column default;
 *  - NULL allowed: a campaign without a budget holds no money and needs no currency.
 *    The app requires one whenever there is a budget (services/Admin/campaignService,
 *    promotionAdminService.syncOwnBudget uses the offer's currency).
 * Existing rows keep their stored currency. Idempotent.
 */
const TABLE = 'campaigns';
const COLUMN = 'currency';

async function columnInfo(queryInterface) {
  const [row] = await queryInterface.sequelize.query(
    `SELECT IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    { replacements: [TABLE, COLUMN], type: queryInterface.sequelize.QueryTypes.SELECT }
  );
  if (!row) throw new Error(`[campaign-currency-only-with-budget] ${TABLE}.${COLUMN} does not exist`);
  return row;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const info = await columnInfo(queryInterface);
    if (info.nullable === 'YES' && info.dflt == null) return;
    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.STRING(3),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    const [{ cnt }] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE ${COLUMN} IS NULL`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    if (Number(cnt) > 0) {
      throw new Error(
        `[campaign-currency-only-with-budget] ${cnt} campaign(s) have no currency; ` +
          'set one before making the column NOT NULL again (never guessed here).'
      );
    }
    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.STRING(3),
      allowNull: false,
    });
  },
};
