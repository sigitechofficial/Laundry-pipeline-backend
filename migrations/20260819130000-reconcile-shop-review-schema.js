'use strict';

const shopReviewMigration = require('./20260811180000-create-shop-review-tables');
const { tableExists } = require('../utils/migrationHelpers');

/**
 * Forward-only repair for databases that recorded the original shop-review
 * migration before all four tables were created. The delegated migration is
 * idempotent and therefore also repairs partially-created schemas.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await shopReviewMigration.up(queryInterface, Sequelize);

    for (const table of [
      'reviewReasonCodes',
      'shopReviews',
      'shopReviewReasons',
      'shopReviewStats',
    ]) {
      if (!(await tableExists(queryInterface, table))) {
        throw new Error(`Shop review schema reconciliation failed: ${table} is missing`);
      }
    }
  },

  // Forward-only reconciliation; restoring a backup is the safe rollback for
  // schema damage. The original migration retains its explicit down operation.
  async down() {},
};
