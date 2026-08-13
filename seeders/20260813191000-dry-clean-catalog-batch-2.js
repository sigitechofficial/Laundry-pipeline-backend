'use strict';

/**
 * Dry Clean catalog Batch 2: Suits, Dresses, Shirts.
 * Idempotent. Legacy disable already handled by batch 1; still safe to re-run.
 */
const { BATCH_2 } = require('./data/dryCleanCatalog');
const { seedDryCleanBatch } = require('./helpers/dryCleanCatalogSeed');

module.exports = {
  async up(queryInterface) {
    await seedDryCleanBatch(queryInterface, BATCH_2, { disableLegacy: false });
  },

  async down() {
    // Non-destructive
  },
};
