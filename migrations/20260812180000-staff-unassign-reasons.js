'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('staffUnassignReasons', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            label: {
                type: Sequelize.STRING(255),
                allowNull: false,
            },
            sortOrder: {
                type: Sequelize.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            status: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
            isOther: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
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

        const now = new Date();
        await queryInterface.bulkInsert('staffUnassignReasons', [
            {
                label: 'Unable to work today / Unwell',
                sortOrder: 1,
                status: true,
                isOther: false,
                createdAt: now,
                updatedAt: now,
            },
            {
                label: 'Vehicle or transport issue',
                sortOrder: 2,
                status: true,
                isOther: false,
                createdAt: now,
                updatedAt: now,
            },
            {
                label: 'Personal emergency',
                sortOrder: 3,
                status: true,
                isOther: false,
                createdAt: now,
                updatedAt: now,
            },
            {
                label: 'Schedule conflict',
                sortOrder: 4,
                status: true,
                isOther: false,
                createdAt: now,
                updatedAt: now,
            },
            {
                label: 'Too far / out of area',
                sortOrder: 5,
                status: true,
                isOther: false,
                createdAt: now,
                updatedAt: now,
            },
            {
                label: 'Other',
                sortOrder: 99,
                status: true,
                isOther: true,
                createdAt: now,
                updatedAt: now,
            },
        ]);

        await queryInterface.addColumn('bookingAssignmentEvents', 'reasonId', {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: {
                model: 'staffUnassignReasons',
                key: 'id',
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
        });
        await queryInterface.addColumn('bookingAssignmentEvents', 'reasonText', {
            type: Sequelize.STRING(255),
            allowNull: true,
        });
        await queryInterface.addColumn('bookingAssignmentEvents', 'note', {
            type: Sequelize.TEXT,
            allowNull: true,
        });
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('bookingAssignmentEvents', 'note');
        await queryInterface.removeColumn('bookingAssignmentEvents', 'reasonText');
        await queryInterface.removeColumn('bookingAssignmentEvents', 'reasonId');
        await queryInterface.dropTable('staffUnassignReasons');
    },
};
