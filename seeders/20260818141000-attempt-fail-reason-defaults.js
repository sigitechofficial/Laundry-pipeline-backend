'use strict';

const {
  DEFAULT_ATTEMPT_FAIL_REASONS,
} = require('../services/Agent/attemptFailReasonCatalog');

/** Idempotent: insert missing codes only. Never overwrite admin edits. */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const now = new Date();

    let existing = [];
    try {
      const [rows] = await sequelize.query(
        `SELECT code FROM attempt_fail_reasons`
      );
      existing = rows || [];
    } catch (err) {
      console.warn(
        '[seed] attempt_fail_reasons table missing — run migrate first:',
        err.message
      );
      return;
    }

    const have = new Set(
      existing.map((r) => String(r.code || '').toLowerCase())
    );
    const rows = DEFAULT_ATTEMPT_FAIL_REASONS.filter(
      (r) => !have.has(String(r.code).toLowerCase())
    ).map((r) => ({
      code: r.code,
      label: r.label,
      description: r.description || null,
      scope: r.scope,
      chargesFee: r.chargesFee,
      requiresNote: r.requiresNote,
      isOther: r.isOther,
      sortOrder: r.sortOrder,
      status: true,
      createdAt: now,
      updatedAt: now,
    }));

    if (!rows.length) {
      console.log('[seed] attempt fail reasons already present');
      return;
    }

    await queryInterface.bulkInsert('attempt_fail_reasons', rows);
    console.log(`[seed] inserted ${rows.length} attempt fail reasons`);
  },

  async down(queryInterface) {
    const codes = DEFAULT_ATTEMPT_FAIL_REASONS.map((r) => r.code);
    await queryInterface.bulkDelete('attempt_fail_reasons', { code: codes });
  },
};
