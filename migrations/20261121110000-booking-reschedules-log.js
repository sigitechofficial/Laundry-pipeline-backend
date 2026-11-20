'use strict';

/**
 * booking_reschedules: one row per reschedule, so the reschedule policy's courtesy count
 * ("N free reschedules in X days") counts reschedules, not orders. Earlier reschedules are
 * copied in from bookings.rescheduledCount (dated at the booking's last update, phase unknown).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [[{ cnt }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'booking_reschedules'`
    );
    if (cnt) return;
    await queryInterface.createTable('booking_reschedules', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      bookingId: { type: Sequelize.INTEGER, allowNull: false },
      customerId: { type: Sequelize.INTEGER, allowNull: false },
      phase: { type: Sequelize.STRING(16), allowNull: true },
      charge: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      driverLate: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('booking_reschedules', ['customerId', 'createdAt'], { name: 'idx_br_customer_created' });
    await queryInterface.addIndex('booking_reschedules', ['bookingId'], { name: 'idx_br_booking' });
    // Earlier reschedules: one row per counted reschedule on each booking.
    const [rows] = await queryInterface.sequelize.query(
      `SELECT id, customerId, rescheduledCount, updatedAt FROM bookings WHERE rescheduledCount > 0 AND customerId IS NOT NULL`
    );
    const copies = [];
    for (const b of rows) {
      for (let i = 0; i < Number(b.rescheduledCount); i += 1) {
        copies.push({ bookingId: b.id, customerId: b.customerId, phase: null, charge: 0, driverLate: false, createdAt: b.updatedAt, updatedAt: b.updatedAt });
      }
    }
    if (copies.length) await queryInterface.bulkInsert('booking_reschedules', copies);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('booking_reschedules');
  },
};
