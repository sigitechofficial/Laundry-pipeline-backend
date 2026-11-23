'use strict';

/**
 * Model columns that no migration ever created.
 *
 * These columns exist in the Sequelize models (67 association foreign keys such as
 * users.userTypeId, plus 9 plain attributes) but were historically added by
 * `sequelize.sync()`, never by a migration. A database built only with `db:migrate`
 * was therefore missing them, and the app failed on the first query that touched them
 * (e.g. admin sign-in: "Unknown column 'userTypeId'").
 *
 * Safe on every environment:
 *  - A column is added only if it does not exist (stage/prod built via sync already have it).
 *  - A foreign key is added only if the column has none yet, and only when no existing
 *    row references a missing parent. Orphaned rows are reported, never modified.
 *  - FK rules match Sequelize's belongsTo defaults: ON DELETE SET NULL, ON UPDATE CASCADE.
 *
 * Guarded by scripts/check-schema-drift.js (CI job "schema-drift").
 */

/** [table, column, referencedTable] — every association FK is INT NULL → <ref>.id */
const FOREIGN_KEYS = [
  ['addressDbs', 'cityId', 'cities'],
  ['addressDbs', 'countryId', 'countries'],
  ['addressDbs', 'userId', 'users'],
  ['addressDbs', 'zoneId', 'zones'],
  ['agentSelectServices', 'agentServiceId', 'users'],
  ['agentSelectServices', 'serviceId', 'services'],
  ['appUnits', 'currencyUnitId', 'units'],
  ['appUnits', 'distanceUnitId', 'units'],
  ['appUnits', 'lengthUnitId', 'units'],
  ['appUnits', 'weightUnitId', 'units'],
  ['baseUnits', 'currencyUnitId', 'units'],
  ['baseUnits', 'distanceUnitId', 'units'],
  ['baseUnits', 'lengthUnitId', 'units'],
  ['baseUnits', 'weightUnitId', 'units'],
  ['bookingHistories', 'bookingId', 'bookings'],
  ['bookingHistories', 'bookingStatusId', 'bookingStatuses'],
  ['bussinessInformations', 'agentId', 'users'],
  ['bussinessInformations', 'shopAddressId', 'addressDbs'],
  ['bussinessWorkingHours', 'bussinessInformationId', 'bussinessInformations'],
  ['bussinessWorkingHours', 'userId', 'users'],
  ['cancelBookings', 'bookingId', 'bookings'],
  ['cancelBookings', 'reasonId', 'reasons'],
  ['cancelBookings', 'userId', 'users'],
  ['cities', 'countryId', 'countries'],
  ['customerSelectedServices', 'bookingId', 'bookings'],
  ['customerSelectedServices', 'categoryId', 'categories'],
  ['customerSelectedServices', 'serviceId', 'services'],
  ['customerSelectedServices', 'subCategoryId', 'subCategories'],
  ['deviceTokens', 'userId', 'users'],
  ['driverDetails', 'userId', 'users'],
  ['driverDetails', 'vehicleTypeId', 'vehicleTypes'],
  ['driverInZones', 'cityId', 'cities'],
  ['driverInZones', 'countryId', 'countries'],
  ['driverInZones', 'driverId', 'users'],
  ['driverInZones', 'laundaryShopId', 'bussinessInformations'],
  ['driverInZones', 'zoneId', 'zones'],
  ['machineCounts', 'bussinessInformationId', 'bussinessInformations'],
  ['machineCounts', 'machineId', 'machines'],
  ['OnHoldConfirmations', 'bookingId', 'bookings'],
  ['OnHoldConfirmations', 'onHoldOptionId', 'onHoldOptions'],
  ['OnHoldConfirmations', 'serviceId', 'services'],
  ['OnHoldConfirmations', 'subCategoryId', 'subCategories'],
  ['onHoldCustomerOptions', 'onHoldOptionId', 'onHoldOptions'],
  ['otpVerifications', 'userId', 'users'],
  ['preferenceValues', 'preferenceTypeId', 'preferenceTypes'],
  ['proofOfDeliveries', 'bookingId', 'bookings'],
  ['proofOfDeliveries', 'userId', 'users'],
  ['serviceCategories', 'categoryId', 'categories'],
  ['serviceCategories', 'serviceId', 'services'],
  ['servicePreferences', 'bookingId', 'bookings'],
  ['servicePreferences', 'preferencesServiceNameId', 'preferencesServiceNames'],
  ['servicePreferences', 'serviceId', 'services'],
  ['serviceWithPreferences', 'preferenceTypeId', 'preferenceTypes'],
  ['serviceWithPreferences', 'serviceId', 'services'],
  ['subCategories', 'categoryId', 'categories'],
  ['tips', 'driverId', 'users'],
  ['users', 'cityId', 'cities'],
  ['users', 'classifiedAsId', 'classifiedAs'],
  ['users', 'countryId', 'countries'],
  ['users', 'roleId', 'roles'],
  ['users', 'userTypeId', 'userTypes'],
  ['vehicleImages', 'driverDetailId', 'driverDetails'],
  ['vehicleModels', 'vehicleMakeId', 'vehicleMakes'],
  ['zones', 'cityId', 'cities'],
  ['zones', 'currencyUnitId', 'units'],
  ['zones', 'distanceUnitId', 'units'],
  ['zones', 'zoneAdminId', 'users'],
];

/** [table, column, spec(Sequelize)] — plain model attributes */
const PLAIN_COLUMNS = (S) => [
  ['bookings', 'noOfBags', { type: S.INTEGER, allowNull: true }],
  ['onHoldCustomerOptions', 'notConfirmText', { type: S.STRING(500), allowNull: true }],
  ['onHoldCustomerOptions', 'deletedAt', { type: S.DATE, allowNull: true }],
  ['policies', 'effectiveFrom', { type: S.DATE, allowNull: true, defaultValue: null }],
  ['policies', 'effectiveTo', { type: S.DATE, allowNull: true, defaultValue: null }],
  ['preferenceTypes', 'deletedAt', { type: S.DATE, allowNull: true }],
  ['preferenceValues', 'deletedAt', { type: S.DATE, allowNull: true }],
  ['serviceCategories', 'deletedAt', { type: S.DATE, allowNull: true }],
  ['serviceWithPreferences', 'deletedAt', { type: S.DATE, allowNull: true }],
];

const fkName = (table, column) => `fk_${table}_${column}`.slice(0, 64);

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql, replacements) =>
      queryInterface.sequelize.query(sql, { replacements, type: Sequelize.QueryTypes.SELECT });

    const columnExists = async (table, column) => {
      const [row] = await q(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
      );
      return Number(row.cnt) > 0;
    };
    const hasForeignKey = async (table, column) => {
      const [row] = await q(
        `SELECT COUNT(*) AS cnt FROM information_schema.key_column_usage
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
            AND referenced_table_name IS NOT NULL`,
        [table, column]
      );
      return Number(row.cnt) > 0;
    };
    const orphanCount = async (table, column, ref) => {
      const [row] = await q(
        `SELECT COUNT(*) AS cnt FROM \`${table}\` t
           LEFT JOIN \`${ref}\` r ON r.id = t.\`${column}\`
          WHERE t.\`${column}\` IS NOT NULL AND r.id IS NULL`
      );
      return Number(row.cnt);
    };

    for (const [table, column, spec] of PLAIN_COLUMNS(Sequelize)) {
      if (!(await columnExists(table, column))) {
        await queryInterface.addColumn(table, column, spec);
      }
    }

    const skipped = [];
    for (const [table, column, ref] of FOREIGN_KEYS) {
      if (!(await columnExists(table, column))) {
        await queryInterface.addColumn(table, column, { type: Sequelize.INTEGER, allowNull: true });
      }
      if (await hasForeignKey(table, column)) continue;
      const orphans = await orphanCount(table, column, ref);
      if (orphans > 0) {
        skipped.push(`${table}.${column} → ${ref}.id (${orphans} orphaned rows)`);
        continue;
      }
      await queryInterface.addConstraint(table, {
        fields: [column],
        type: 'foreign key',
        name: fkName(table, column),
        references: { table: ref, field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }

    if (skipped.length) {
      // Data needs a human decision; never null or delete rows from a migration.
      console.warn(
        '[migration model-association-columns] Foreign keys NOT added because existing rows ' +
          'reference missing parents. Clean the data, then re-run a follow-up migration:\n  ' +
          skipped.join('\n  ')
      );
    }
  },

  /**
   * Removes only the foreign keys this migration created (named fk_<table>_<column>).
   * Columns are kept: on environments built via sync they predate this migration and hold data.
   */
  async down(queryInterface) {
    for (const [table, column] of FOREIGN_KEYS) {
      const name = fkName(table, column);
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.table_constraints
          WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?`,
        { replacements: [table, name] }
      );
      if (Number(rows[0].cnt) > 0) await queryInterface.removeConstraint(table, name);
    }
  },
};
