'use strict';

/**
 * bookings.policySnapshot: a copy of the cancellation, reschedule and no-show rules in force when
 * the order was booked. Editing a policy later changes it for new orders only; orders already
 * booked keep the rules they were booked under. Older bookings have no copy and keep using the
 * policy record (as before).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [[{ cnt }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings' AND column_name = 'policySnapshot'`
    );
    if (cnt) return;
    await queryInterface.addColumn('bookings', 'policySnapshot', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Cancellation / reschedule / no-show rules copied when the order was booked',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('bookings', 'policySnapshot');
  },
};
