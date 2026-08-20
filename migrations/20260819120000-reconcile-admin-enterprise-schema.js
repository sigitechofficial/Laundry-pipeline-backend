'use strict';

const complianceMigration = require('./20260817150000-agent-fail-instructions-and-compliance-events');
const failReasonsMigration = require('./20260818140000-attempt-fail-reasons');
const failReasonComplianceMigration = require('./20260818150000-attempt-fail-reason-requires-compliance');
const { tableExists } = require('../utils/migrationHelpers');

/**
 * Forward-only reconciliation for environments where an earlier deployment
 * recorded a migration before all of its DDL was present. Each delegated
 * migration is idempotent, so healthy databases are unchanged.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await complianceMigration.up(queryInterface, Sequelize);
    await failReasonsMigration.up(queryInterface, Sequelize);
    await failReasonComplianceMigration.up(queryInterface, Sequelize);

    const requiredTables = [
      'attempt_fail_instruction_sets',
      'attempt_fail_instructions',
      'attempt_fail_reasons',
      'agent_compliance_events',
    ];
    for (const table of requiredTables) {
      if (!(await tableExists(queryInterface, table))) {
        throw new Error(`Enterprise schema reconciliation failed: ${table} is missing`);
      }
    }

    const bookingColumns = await queryInterface.describeTable('bookings');
    for (const column of [
      'pickupArrivedGeofenceOverride',
      'deliveryArrivedGeofenceOverride',
      'pickupCompleteGeofenceOverride',
      'deliveryCompleteGeofenceOverride',
    ]) {
      if (!bookingColumns[column]) {
        throw new Error(
          `Enterprise schema reconciliation failed: bookings.${column} is missing`
        );
      }
    }

    const failReasonColumns = await queryInterface.describeTable(
      'attempt_fail_reasons'
    );
    if (!failReasonColumns.requiresCompliance) {
      throw new Error(
        'Enterprise schema reconciliation failed: attempt_fail_reasons.requiresCompliance is missing'
      );
    }
  },

  // Reconciliation intentionally has no destructive rollback. The delegated
  // migrations own schema removal if an explicit feature rollback is required.
  async down() {},
};
