'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.bulkInsert('bookingStatuses', [
      {
        title: 'Order Created',
        description: 'Your Order has been created.',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Confirmed",
        description: 'The booking has been confirmed and is ready for collection.',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Driver Out for PickUp",
        description: "Driver accepted the the booking and coming for laundary pickup",
        createdAt: new Date(),
        updatedAt: new Date()

      },
      {
        title: "Awaiting Collection",
        description: "The booking is active, and the driver/agent is scheduled to collect the items at the specified time.",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Driver Reached Pickup",
        description: "Driver reached at customer location for Pickup",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'PickingUp and Inspection',
        description: 'Driver reached for laundary Pickup and inspecting the items',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "In Transit to Facility",
        description: "Items have been collected and are en route to the laundry facility.",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Delivered Laundry to Shop",
        description: "Driver Deliver Laundry to laundry Shop",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Invoice Generated",
        description: "Inscpection Completed and payment Confirmed",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'Processing',
        description: 'Items are being serviced',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'Completed (At Facility)',
        description: "The service is complete, and items are ready for delivery",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Out for Delivery",
        description: "The order is en route to the customer.",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'Driver Reached',
        description: "Your driver has been arrived",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'Delivery Failed',
        description: 'The delivery attempt was unsuccessful',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'Delivered',
        description: 'Items have been successfully delivered to the customer.',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Completed",
        description: 'The entire booking process, including collection, servicing, and delivery, is finished.',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'On Hold/Waiting for customer response',
        description: 'The order is temporarily paused due to an issue',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Cancelled",
        description: 'The booking has been canceled by the customer, admin, or due to payment issues.',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Return to Processing",
        description: "If it was a temporary issue (e.g., special instructions clarified or additional fee paid).",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Refunded",
        description: "If payment was taken and the service gets canceled thereafter.",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Issue Resolving",
        description: 'Resolving the pending issue of On Hold Booking',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: "Issue Resolved",
        description: "Booking issue resolved",
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        title: 'onHold/Waiting for agent response',
        description: 'Agent update the issue is resolved',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ])
  },

  async down(queryInterface, Sequelize) {
    /**
     * Add commands to revert seed here.
     *
     * Example:
     * await queryInterface.bulkDelete('People', null, {});
     */
    await queryInterface.bulkDelete('bookingStatuses', null, {})
  }
};
