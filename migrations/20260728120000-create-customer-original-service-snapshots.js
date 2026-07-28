'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const tables = await queryInterface.showAllTables();
        const normalized = tables.map((t) => (typeof t === 'string' ? t : t.tableName));

        // 1. customerOriginalServiceSnapshots — frozen copy of customer-selected services
        if (!normalized.includes('customerOriginalServiceSnapshots')) {
            await queryInterface.createTable('customerOriginalServiceSnapshots', {
                id: {
                    allowNull: false,
                    autoIncrement: true,
                    primaryKey: true,
                    type: Sequelize.INTEGER
                },
                bookingId: {
                    type: Sequelize.INTEGER,
                    allowNull: false,
                    references: { model: 'bookings', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'CASCADE'
                },
                serviceId: {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    references: { model: 'services', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'SET NULL'
                },
                categoryId: {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    references: { model: 'categories', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'SET NULL'
                },
                subCategoryId: {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    references: { model: 'subCategories', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'SET NULL'
                },
                items: {
                    type: Sequelize.INTEGER,
                    allowNull: true
                },
                bags: {
                    type: Sequelize.INTEGER,
                    allowNull: true
                },
                categoryPrice: {
                    type: Sequelize.DECIMAL(10, 2),
                    allowNull: true
                },
                serviceInstruction: {
                    type: Sequelize.TEXT,
                    allowNull: true
                },
                createdAt: { allowNull: false, type: Sequelize.DATE },
                updatedAt: { allowNull: false, type: Sequelize.DATE }
            });

            await queryInterface.addIndex(
                'customerOriginalServiceSnapshots',
                ['bookingId'],
                { name: 'coss_booking_idx' }
            );
        }

        // 2. customerOriginalPreferenceSnapshots — frozen copy of customer preferences
        if (!normalized.includes('customerOriginalPreferenceSnapshots')) {
            await queryInterface.createTable('customerOriginalPreferenceSnapshots', {
                id: {
                    allowNull: false,
                    autoIncrement: true,
                    primaryKey: true,
                    type: Sequelize.INTEGER
                },
                bookingId: {
                    type: Sequelize.INTEGER,
                    allowNull: false,
                    references: { model: 'bookings', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'CASCADE'
                },
                snapshotServiceId: {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    references: { model: 'customerOriginalServiceSnapshots', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'SET NULL'
                },
                preferenceTypeId: {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    references: { model: 'preferenceTypes', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'SET NULL'
                },
                preferenceValueId: {
                    type: Sequelize.INTEGER,
                    allowNull: true,
                    references: { model: 'preferenceValues', key: 'id' },
                    onUpdate: 'CASCADE',
                    onDelete: 'SET NULL'
                },
                parentPreferenceValueId: {
                    type: Sequelize.INTEGER,
                    allowNull: true
                },
                preferenceInstruction: {
                    type: Sequelize.TEXT,
                    allowNull: true
                },
                createdAt: { allowNull: false, type: Sequelize.DATE },
                updatedAt: { allowNull: false, type: Sequelize.DATE }
            });

            await queryInterface.addIndex(
                'customerOriginalPreferenceSnapshots',
                ['bookingId'],
                { name: 'cops_booking_idx' }
            );
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('customerOriginalPreferenceSnapshots').catch(() => {});
        await queryInterface.dropTable('customerOriginalServiceSnapshots').catch(() => {});
    }
};
