'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Automatic WhatsApp messages to customers (Twilio, approved templates):
 *  - whatsappMessages: one row per message (event per booking), its Twilio id and
 *    delivery status, so the same message is never sent twice and admins can see
 *    what went out.
 *  - whatsappOptOuts: customers who asked not to get WhatsApp messages.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'whatsappMessages'))) {
      await queryInterface.createTable('whatsappMessages', {
        id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER },
        bookingId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'bookings', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        customerId: { type: Sequelize.INTEGER, allowNull: true },
        event: { type: Sequelize.STRING(40), allowNull: false, comment: 'pickup_on_the_way | on_hold | payment_failed | out_for_delivery | delivered' },
        dedupeKey: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '', comment: 'Lets an event repeat on purpose (e.g. a later payment failure)' },
        toMasked: { type: Sequelize.STRING(32), allowNull: true },
        templateSid: { type: Sequelize.STRING(64), allowNull: true },
        twilioSid: { type: Sequelize.STRING(64), allowNull: true },
        status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'queued', comment: 'queued | sent | delivered | read | failed | undelivered' },
        error: { type: Sequelize.STRING(255), allowNull: true },
        sentAt: { type: Sequelize.DATE, allowNull: true },
        deliveredAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
      await queryInterface.addIndex('whatsappMessages', ['bookingId', 'event', 'dedupeKey'], {
        unique: true,
        name: 'whatsapp_messages_booking_event_dedupe',
      });
      await queryInterface.addIndex('whatsappMessages', ['twilioSid'], { name: 'whatsapp_messages_twilio_sid' });
      await queryInterface.addIndex('whatsappMessages', ['createdAt'], { name: 'whatsapp_messages_created_at' });
    }

    if (!(await tableExists(queryInterface, 'whatsappOptOuts'))) {
      await queryInterface.createTable('whatsappOptOuts', {
        id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          unique: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      });
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'whatsappOptOuts')) await queryInterface.dropTable('whatsappOptOuts');
    if (await tableExists(queryInterface, 'whatsappMessages')) await queryInterface.dropTable('whatsappMessages');
  },
};
