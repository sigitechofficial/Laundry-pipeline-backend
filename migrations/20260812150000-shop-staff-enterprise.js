'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('bookingAssignmentEvents', {
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
            assignmentType: {
                type: Sequelize.STRING(20),
                allowNull: false,
                comment: 'pickup | delivery',
            },
            action: {
                type: Sequelize.STRING(20),
                allowNull: false,
                comment: 'assign | unassign | reassign | auto',
            },
            fromUserId: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            },
            toUserId: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            },
            actedByUserId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            source: {
                type: Sequelize.STRING(20),
                allowNull: false,
                defaultValue: 'manual',
                comment: 'manual | auto',
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

        await queryInterface.addIndex('bookingAssignmentEvents', ['bookingId'], {
            name: 'booking_assignment_events_booking_id',
        });
        await queryInterface.addIndex('bookingAssignmentEvents', ['toUserId'], {
            name: 'booking_assignment_events_to_user_id',
        });
        await queryInterface.addIndex('bookingAssignmentEvents', ['createdAt'], {
            name: 'booking_assignment_events_created_at',
        });

        await queryInterface.createTable('employeeCapabilityOverrides', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            userId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            capabilityKey: {
                type: Sequelize.STRING(64),
                allowNull: false,
            },
            allowed: {
                type: Sequelize.BOOLEAN,
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
            'employeeCapabilityOverrides',
            ['userId', 'capabilityKey'],
            {
                unique: true,
                name: 'employee_capability_overrides_user_key_unique',
            }
        );

        await queryInterface.createTable('shopAutoAssignSettings', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            shopUserId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                unique: true,
                references: {
                    model: 'users',
                    key: 'id',
                },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            enabled: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            strategy: {
                type: Sequelize.STRING(32),
                allowNull: false,
                defaultValue: 'round_robin',
            },
            scope: {
                type: Sequelize.STRING(20),
                allowNull: false,
                defaultValue: 'both',
                comment: 'pickup | delivery | both',
            },
            fallbackToOwner: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true,
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
    },

    async down(queryInterface) {
        await queryInterface.dropTable('shopAutoAssignSettings');
        await queryInterface.dropTable('employeeCapabilityOverrides');
        await queryInterface.dropTable('bookingAssignmentEvents');
    },
};
