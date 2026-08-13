'use strict';

/**
 * Dry Clean catalog Batch 1: Trousers, Shorts, Jackets.
 * Disables legacy Dry Clean categories not in the new allowlist (status=false).
 * Idempotent create/revive for categories + subcategories.
 * Prices: UK dry-clean defaults via priceForItem (GBP).
 */
const { BATCH_1 } = require('./data/dryCleanCatalog');
const { seedDryCleanBatch } = require('./helpers/dryCleanCatalogSeed');

module.exports = {
  async up(queryInterface) {
    await seedDryCleanBatch(queryInterface, BATCH_1, { disableLegacy: true });
  },

  async down() {
    // Non-destructive: do not re-enable legacy or delete catalog rows.
  },
};
