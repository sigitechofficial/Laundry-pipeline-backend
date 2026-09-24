'use strict';

const { tableExists } = require('../utils/migrationHelpers');

/**
 * Audit trail for admin-driven changes to how an order's balance is collected
 * (card <-> cash). Mirrors bookingAssignmentEvents: who changed it, from/to,
 * reason code + free text, and a note. Idempotent create.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        if (await tableExists(queryInterface, 'bookingPaymentMethodEvents')) {
            return;
        }
        await queryInterface.createTable('bookingPaymentMethodEvents', {
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
            // Which field changed: today always 'balancePaymentMethod'.
            field: {
                type: Sequelize.STRING(32),
                allowNull: false,
                defaultValue: 'balancePaymentMethod',
            },
            fromMethod: {
                type: Sequelize.STRING(16),
                allowNull: true,
            },
            toMethod: {
                type: Sequelize.STRING(16),
                allowNull: false,
            },
            actedByUserId: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'users', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'SET NULL',
            },
            actorType: {
                type: Sequelize.STRING(16),
                allowNull: false,
                defaultValue: 'admin',
            },
            reasonCode: {
                type: Sequelize.STRING(64),
                allowNull: true,
            },
            reasonText: {
                type: Sequelize.STRING(255),
                allowNull: true,
            },
            note: {
                type: Sequelize.TEXT,
                allowNull: true,
            },
            // Snapshot of the balance owed at the moment of the change, so the
            // audit row is meaningful even if the invoice changes later.
            amountDueSnapshot: {
                type: Sequelize.DECIMAL(10, 2),
                allowNull: true,
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
        });
        await queryInterface.addIndex('bookingPaymentMethodEvents', ['bookingId']);
    },

    async down(queryInterface) {
        if (await tableExists(queryInterface, 'bookingPaymentMethodEvents')) {
            await queryInterface.dropTable('bookingPaymentMethodEvents');
        }
    },
};
