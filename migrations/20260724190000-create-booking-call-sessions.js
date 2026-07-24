'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('booking_call_sessions', {
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
            agentUserId: {
                type: Sequelize.INTEGER,
                allowNull: false,
            },
            leg: {
                type: Sequelize.ENUM('pickup', 'delivery'),
                allowNull: false,
            },
            agentPhoneE164: {
                type: Sequelize.STRING(32),
                allowNull: false,
            },
            status: {
                type: Sequelize.ENUM('active', 'closed', 'expired'),
                allowNull: false,
                defaultValue: 'active',
            },
            expiresAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            closedAt: {
                type: Sequelize.DATE,
                allowNull: true,
            },
            closeReason: {
                type: Sequelize.STRING(64),
                allowNull: true,
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

        await queryInterface.addIndex('booking_call_sessions', ['agentPhoneE164', 'status'], {
            name: 'booking_call_sessions_agent_phone_status_idx',
        });
        await queryInterface.addIndex('booking_call_sessions', ['bookingId', 'leg', 'status'], {
            name: 'booking_call_sessions_booking_leg_status_idx',
        });
        await queryInterface.addIndex('booking_call_sessions', ['expiresAt'], {
            name: 'booking_call_sessions_expires_idx',
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('booking_call_sessions');
    },
};
