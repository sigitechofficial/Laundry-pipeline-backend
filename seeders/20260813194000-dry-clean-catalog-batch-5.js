'use strict';

/**
 * Dry Clean catalog Batch 5: Suede, Waxed Garments, Ski Wear.
 * Prices: UK defaults via priceForItem.
 */
const { BATCH_5 } = require('./data/dryCleanCatalog');
const { seedDryCleanBatch } = require('./helpers/dryCleanCatalogSeed');

module.exports = {
  async up(queryInterface) {
    await seedDryCleanBatch(queryInterface, BATCH_5, { disableLegacy: true });
  },

  async down() {
    // Non-destructive
  },
};
