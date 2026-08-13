'use strict';

/**
 * Dry Clean catalog Batch 6: Motorcycle Clothing, Jewish / Religious Items.
 * Prices: UK defaults via priceForItem.
 */
const { BATCH_6 } = require('./data/dryCleanCatalog');
const { seedDryCleanBatch } = require('./helpers/dryCleanCatalogSeed');

module.exports = {
  async up(queryInterface) {
    await seedDryCleanBatch(queryInterface, BATCH_6, { disableLegacy: true });
  },

  async down() {
    // Non-destructive
  },
};
