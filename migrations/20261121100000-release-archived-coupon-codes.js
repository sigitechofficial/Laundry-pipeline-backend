'use strict';

/**
 * A coupon code is unique among promotions that can still run. When a promotion is archived
 * (final: it can never run again) its codes are released, so the same code can be used on a
 * new promotion. Orders keep pointing at the archived code row (couponCodeId), so history and
 * reports stay with the old promotion.
 *
 *  - coupon_codes.releasedAt: when the code was given back (null = still taken).
 *  - coupon_codes.liveCode: generated = code while not released, else NULL. The unique index
 *    moves from code to liveCode, so the database itself still allows each live code once
 *    (MySQL lets many rows have NULL in a unique index).
 *  - Codes of promotions archived before this change are released now.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[{ cnt: hasReleased }]] = await q(`SELECT COUNT(*) AS cnt FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'coupon_codes' AND column_name = 'releasedAt'`);
    if (!hasReleased) {
      await queryInterface.addColumn('coupon_codes', 'releasedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Set when the promotion is archived: the code may then be used by a new promotion',
      });
    }
    const [[{ cnt: hasLive }]] = await q(`SELECT COUNT(*) AS cnt FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'coupon_codes' AND column_name = 'liveCode'`);
    if (!hasLive) {
      await q(`ALTER TABLE coupon_codes
        ADD COLUMN liveCode VARCHAR(50) GENERATED ALWAYS AS (CASE WHEN releasedAt IS NULL THEN code END) STORED`);
    }
    const [indexes] = await q(`SHOW INDEX FROM coupon_codes`);
    const has = (name) => indexes.some((i) => i.Key_name === name);
    if (!has('idx_cc_live_code')) await queryInterface.addIndex('coupon_codes', ['liveCode'], { name: 'idx_cc_live_code', unique: true });
    if (has('idx_cc_code')) await queryInterface.removeIndex('coupon_codes', 'idx_cc_code');
    // Sequelize's own "unique: true" on code may also have made an index named after the column.
    if (has('code')) await queryInterface.removeIndex('coupon_codes', 'code');
    if (!has('idx_cc_code_lookup')) await queryInterface.addIndex('coupon_codes', ['code'], { name: 'idx_cc_code_lookup' });

    await q(`UPDATE coupon_codes cc JOIN promotions p ON p.id = cc.promotionId
      SET cc.releasedAt = COALESCE(p.updatedAt, NOW())
      WHERE p.status = 'archived' AND cc.releasedAt IS NULL`);
  },

  async down(queryInterface) {
    // Only safe while no released code has been reused (the old index allows each code once).
    await queryInterface.removeIndex('coupon_codes', 'idx_cc_code_lookup');
    await queryInterface.addIndex('coupon_codes', ['code'], { name: 'idx_cc_code', unique: true });
    await queryInterface.removeIndex('coupon_codes', 'idx_cc_live_code');
    await queryInterface.removeColumn('coupon_codes', 'liveCode');
    await queryInterface.removeColumn('coupon_codes', 'releasedAt');
  },
};
