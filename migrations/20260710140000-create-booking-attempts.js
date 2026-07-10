'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('booking_attempts', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            bookingId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: 'bookings', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            attemptType: {
                type: Sequelize.ENUM('pickup', 'delivery'),
                allowNull: false,
            },
            attemptNumber: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 1,
            },
            status: {
                type: Sequelize.ENUM(
                    'arrived',
                    'completed',
                    'unattended',
                    'failed',
                    'superseded'
                ),
                allowNull: false,
                defaultValue: 'arrived',
            },
            arrivedAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            completedAt: {
                type: Sequelize.DATE,
                allowNull: true,
            },
            failedAt: {
                type: Sequelize.DATE,
                allowNull: true,
            },
            driverId: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'users', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            },
            driverLateMinutes: {
                type: Sequelize.INTEGER,
                allowNull: true,
            },
            feeAmount: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            },
            feeCurrency: {
                type: Sequelize.STRING(10),
                allowNull: true,
                defaultValue: 'USD',
            },
            feeWaived: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            feeWaiveReason: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },
            failureReason: {
                type: Sequelize.STRING(500),
                allowNull: true,
            },
            unattendedMethod: {
                type: Sequelize.ENUM('bag_at_door', 'concierge', 'locker'),
                allowNull: true,
            },
            noShowPolicyId: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'policies', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
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

        await queryInterface.addIndex('booking_attempts', ['bookingId', 'attemptType', 'attemptNumber'], {
            name: 'booking_attempts_booking_type_number',
        });
        await queryInterface.addIndex('booking_attempts', ['bookingId', 'status'], {
            name: 'booking_attempts_booking_status',
        });

        const bookingTable = await queryInterface.describeTable('bookings');

        if (!bookingTable.pickupAttemptCount) {
            await queryInterface.addColumn('bookings', 'pickupAttemptCount', {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
            });
        }
        if (!bookingTable.deliveryAttemptCount) {
            await queryInterface.addColumn('bookings', 'deliveryAttemptCount', {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
            });
        }
        if (!bookingTable.maxPickupAttempts) {
            await queryInterface.addColumn('bookings', 'maxPickupAttempts', {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 3,
            });
        }
        if (!bookingTable.noShowFeeAccrued) {
            await queryInterface.addColumn('bookings', 'noShowFeeAccrued', {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            });
        }
        if (!bookingTable.noShowPolicyId) {
            await queryInterface.addColumn('bookings', 'noShowPolicyId', {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'policies', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            });
        }
        if (!bookingTable.cancellationPolicyId) {
            await queryInterface.addColumn('bookings', 'cancellationPolicyId', {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'policies', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            });
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('booking_attempts');
        const bookingTable = await queryInterface.describeTable('bookings');
        const cols = [
            'pickupAttemptCount',
            'deliveryAttemptCount',
            'maxPickupAttempts',
            'noShowFeeAccrued',
            'noShowPolicyId',
            'cancellationPolicyId',
        ];
        for (const col of cols) {
            if (bookingTable[col]) {
                await queryInterface.removeColumn('bookings', col);
            }
        }
    },
};
