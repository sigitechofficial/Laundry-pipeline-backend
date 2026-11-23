'use strict';

/**
 * Customer-declared service snapshots were created check-then-insert without a lock,
 * so concurrent reads of a booking (the shop app loads an invoice twice on open)
 * could freeze the same service more than once — the shop then saw the customer's
 * choice duplicated. The service now freezes under a booking row lock; this:
 *
 *   1. removes duplicate snapshot rows per (bookingId, serviceId), keeping the first,
 *      with the preference snapshots that were copied onto the removed rows;
 *   2. removes duplicated booking-level preference snapshots (same booking, same
 *      preference, no service), keeping the first;
 *   3. adds a unique index on (bookingId, serviceId) so the database refuses
 *      duplicates outright. Rows without a service (NULL) stay allowed, as before.
 */
const SERVICES = 'customerOriginalServiceSnapshots';
const PREFS = 'customerOriginalPreferenceSnapshots';
const INDEX = 'uniq_declared_snapshot_booking_service';

async function indexExists(queryInterface, table, name) {
  const indexes = await queryInterface.showIndex(table);
  return (indexes || []).some((idx) => idx?.name === name);
}

module.exports = {
  async up(queryInterface) {
    const q = (sql, transaction) => queryInterface.sequelize.query(sql, { transaction });
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Ids are collected first (derived tables): MySQL deletes while scanning, so a
      // self-joined DELETE would miss rows whose "keeper" it had already removed.
      const dupServiceIds = `
        SELECT id FROM (
          SELECT s.id FROM ${SERVICES} s
          JOIN ${SERVICES} keep
            ON keep.bookingId = s.bookingId AND keep.serviceId = s.serviceId AND keep.id < s.id
        ) d`;

      // 1. Duplicate service snapshots (and the preferences copied onto them).
      await q(`DELETE FROM ${PREFS} WHERE snapshotServiceId IN (${dupServiceIds})`, transaction);
      await q(`DELETE FROM ${SERVICES} WHERE id IN (${dupServiceIds})`, transaction);

      // 2. Duplicated booking-level preferences.
      await q(`
        DELETE FROM ${PREFS} WHERE id IN (
          SELECT id FROM (
            SELECT p.id FROM ${PREFS} p
            JOIN ${PREFS} keep
              ON keep.bookingId = p.bookingId
             AND keep.snapshotServiceId IS NULL AND p.snapshotServiceId IS NULL
             AND keep.preferenceTypeId <=> p.preferenceTypeId
             AND keep.preferenceValueId <=> p.preferenceValueId
             AND keep.parentPreferenceValueId <=> p.parentPreferenceValueId
             AND keep.preferenceInstruction <=> p.preferenceInstruction
             AND keep.id < p.id
          ) d
        )
      `, transaction);
    });

    // 3. Enforce it.
    if (!(await indexExists(queryInterface, SERVICES, INDEX))) {
      await queryInterface.addIndex(SERVICES, ['bookingId', 'serviceId'], {
        name: INDEX,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    if (await indexExists(queryInterface, SERVICES, INDEX)) {
      await queryInterface.removeIndex(SERVICES, INDEX);
    }
    // Removed duplicates are not restored: they were copies.
  },
};
