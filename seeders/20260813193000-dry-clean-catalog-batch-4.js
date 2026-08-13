'use strict';

/**
 * Dry Clean catalog Batch 4: Coats, Miscellaneous Items, Leather.
 * Prices: UK defaults via priceForItem.
 */
const { BATCH_4 } = require('./data/dryCleanCatalog');
const { seedDryCleanBatch } = require('./helpers/dryCleanCatalogSeed');

module.exports = {
  async up(queryInterface) {
    await seedDryCleanBatch(queryInterface, BATCH_4, { disableLegacy: true });
  },

  async down() {
    // Non-destructive
  },
};
