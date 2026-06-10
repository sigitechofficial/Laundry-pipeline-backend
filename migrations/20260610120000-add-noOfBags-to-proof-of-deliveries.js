"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("proofOfDeliveries");

    if (!table.noOfBags) {
      await queryInterface.addColumn("proofOfDeliveries", "noOfBags", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    // Backfill from booking-level bag count for existing pickup proofs
    await queryInterface.sequelize.query(`
      UPDATE proofOfDeliveries AS pod
      INNER JOIN bookings AS b ON b.id = pod.bookingId
      SET pod.noOfBags = COALESCE(b.totalBags, b.noOfBags)
      WHERE pod.noOfBags IS NULL
        AND COALESCE(b.totalBags, b.noOfBags) IS NOT NULL
    `);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("proofOfDeliveries");
    if (table.noOfBags) {
      await queryInterface.removeColumn("proofOfDeliveries", "noOfBags");
    }
  },
};
