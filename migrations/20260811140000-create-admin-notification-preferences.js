'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('admin_notification_preferences', {
            id: {
                allowNull: false,
                autoIncrement: true,
                primaryKey: true,
                type: Sequelize.INTEGER,
            },
            adminUserId: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: { model: 'users', key: 'id' },
                onUpdate: 'CASCADE',
                onDelete: 'CASCADE',
            },
            alertType: {
                type: Sequelize.STRING(64),
                allowNull: false,
            },
            enabled: {
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

        await queryInterface.addIndex(
            'admin_notification_preferences',
            ['adminUserId', 'alertType'],
            { unique: true, name: 'admin_notification_preferences_admin_alert_unique' }
        );
        await queryInterface.addIndex(
            'admin_notification_preferences',
            ['alertType']
        );
    },

    async down(queryInterface) {
        await queryInterface.dropTable('admin_notification_preferences');
    },
};
