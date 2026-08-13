'use strict';

/**
 * Dry Clean catalog Batch 3: Knitwear / Cardigans, Skirts, Tops & Blouses.
 */
const { BATCH_3 } = require('./data/dryCleanCatalog');
const { seedDryCleanBatch } = require('./helpers/dryCleanCatalogSeed');

module.exports = {
  async up(queryInterface) {
    await seedDryCleanBatch(queryInterface, BATCH_3, { disableLegacy: false });
  },

  async down() {
    // Non-destructive
  },
};
