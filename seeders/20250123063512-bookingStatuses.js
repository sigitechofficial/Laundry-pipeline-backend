'use strict';

const { insertMissing, deleteSeeded } = require('./helpers/idempotentSeed');

/**
 * Booking statuses. Ids follow the original insertion order and are referenced by booking logic.
 * Idempotent: inserts only missing rows (by id); undo removes only these rows.
 */
const ROWS = [
  { id: 1, title: 'Order Created', description: 'Your Order has been created.' },
  {
    id: 2,
    title: 'Confirmed',
    description: 'The booking has been confirmed and is ready for collection.'
  },
  {
    id: 3,
    title: 'Awaiting Collection',
    description: 'The booking is active, and the driver/agent is scheduled to collect the items at the specified time.'
  },
  {
    id: 4,
    title: 'Driver Out for PickUp',
    description: 'Driver accepted the the booking and coming for laundary pickup'
  },
  {
    id: 5,
    title: 'Driver Reached Pickup',
    description: 'Driver reached at customer location for Pickup'
  },
  {
    id: 6,
    title: 'PickingUp and Inspection',
    description: 'Driver reached for laundary Pickup and inspecting the items'
  },
  {
    id: 7,
    title: 'In Transit to Facility',
    description: 'Items have been collected and are en route to the laundry facility.'
  },
  {
    id: 8,
    title: 'Delivered Laundry to Shop',
    description: 'Driver Deliver Laundry to laundry Shop'
  },
  {
    id: 9,
    title: 'Agent Added the Services',
    description: 'Agent Added the Customer Services'
  },
  {
    id: 10,
    title: 'Invoice Generated',
    description: 'Inscpection Completed and payment Confirmed'
  },
  { id: 11, title: 'Processing', description: 'Items are being serviced' },
  {
    id: 12,
    title: 'Completed (At Facility)',
    description: 'The service is complete, and items are ready for delivery'
  },
  {
    id: 13,
    title: 'Out for Delivery',
    description: 'The order is en route to the customer.'
  },
  { id: 14, title: 'Driver Reached', description: 'Your driver has been arrived' },
  {
    id: 15,
    title: 'Delivery Failed',
    description: 'The delivery attempt was unsuccessful'
  },
  {
    id: 16,
    title: 'Delivered',
    description: 'Items have been successfully delivered to the customer.'
  },
  {
    id: 17,
    title: 'Completed',
    description: 'The entire booking process, including collection, servicing, and delivery, is finished.'
  },
  {
    id: 18,
    title: 'On Hold/Waiting for customer response',
    description: 'The order is temporarily paused due to an issue'
  },
  {
    id: 19,
    title: 'Cancelled',
    description: 'The booking has been canceled by the customer, admin, or due to payment issues.'
  },
  {
    id: 20,
    title: 'Return to Processing',
    description: 'If it was a temporary issue (e.g., special instructions clarified or additional fee paid).'
  },
  {
    id: 21,
    title: 'Refunded',
    description: 'If payment was taken and the service gets canceled thereafter.'
  },
  {
    id: 22,
    title: 'Issue Resolving',
    description: 'Resolving the pending issue of On Hold Booking'
  },
  { id: 23, title: 'Issue Resolved', description: 'Booking issue resolved' },
  {
    id: 24,
    title: 'onHold/Waiting for agent response',
    description: 'Agent update the issue is resolved'
  }
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await insertMissing(queryInterface, 'bookingStatuses', ROWS);
  },

  async down(queryInterface) {
    await deleteSeeded(queryInterface, 'bookingStatuses', ROWS);
  },
};
