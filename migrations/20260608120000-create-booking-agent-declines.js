'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('bookingAgentDeclines', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            bookingId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'bookings',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            agentUserId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            reason: {
                type: Sequelize.STRING(500),
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

        await queryInterface.addIndex('bookingAgentDeclines', ['bookingId', 'agentUserId'], {
            unique: true,
            name: 'booking_agent_declines_booking_agent_unique',
        });
        await queryInterface.addIndex('bookingAgentDeclines', ['agentUserId'], {
            name: 'booking_agent_declines_agent_user_id',
        });
        await queryInterface.addIndex('bookingAgentDeclines', ['bookingId'], {
            name: 'booking_agent_declines_booking_id',
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('bookingAgentDeclines');
    },
};
