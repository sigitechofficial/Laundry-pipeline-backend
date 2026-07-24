'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        // No FKs — avoids MySQL errno 150 across mixed engines/charsets in this project.
        await queryInterface.createTable('booking_notifications', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            bookingId: {
                type: Sequelize.INTEGER,
                allowNull: false,
            },
            attemptId: {
                type: Sequelize.INTEGER,
                allowNull: true,
            },
            leg: {
                type: Sequelize.ENUM('pickup', 'delivery'),
                allowNull: false,
            },
            channel: {
                type: Sequelize.ENUM('sms', 'call'),
                allowNull: false,
                defaultValue: 'sms',
            },
            agentUserId: {
                type: Sequelize.INTEGER,
                allowNull: true,
            },
            twilioSid: {
                type: Sequelize.STRING(64),
                allowNull: true,
            },
            twilioStatus: {
                type: Sequelize.STRING(32),
                allowNull: true,
            },
            bodyPreview: {
                type: Sequelize.STRING(200),
                allowNull: true,
            },
            toMasked: {
                type: Sequelize.STRING(32),
                allowNull: true,
            },
            fromNumber: {
                type: Sequelize.STRING(32),
                allowNull: true,
            },
            sentAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            createdAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
            updatedAt: {
                allowNull: false,
                type: Sequelize.DATE,
            },
        });

        await queryInterface.addIndex(
            'booking_notifications',
            ['bookingId', 'leg', 'channel'],
            { name: 'booking_notifications_booking_leg_channel_idx' }
        );
        await queryInterface.addIndex('booking_notifications', ['attemptId'], {
            name: 'booking_notifications_attempt_id_idx',
        });
        await queryInterface.addIndex('booking_notifications', ['bookingId', 'sentAt'], {
            name: 'booking_notifications_booking_sent_idx',
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('booking_notifications');
    },
};
